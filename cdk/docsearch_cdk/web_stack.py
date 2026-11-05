import os
import shutil
import subprocess
from pathlib import Path

import jsii
from aws_cdk import (
    BundlingOptions,
    CfnOutput,
    DockerImage,
    Duration,
    ILocalBundling,
    RemovalPolicy,
    Stack,
)
from aws_cdk import aws_apigatewayv2 as apigw
from aws_cdk import aws_apigatewayv2_integrations as integrations
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_deployment as s3deploy
from constructs import Construct

# The Go module that holds both the CLI and the Lambda entry point.
GO_SRC = Path(__file__).resolve().parents[2] / "go_files"

# Lambda build flags: a static linux/arm64 binary named `bootstrap`, which is
# what the provided.al2023 runtime executes.
GO_BUILD_ENV = {"GOOS": "linux", "GOARCH": "arm64", "CGO_ENABLED": "0"}
GO_PACKAGE = "./cmd/api-lambda"

# The React frontend, built with `npm run build` into the site bucket.
WEB_SRC = Path(__file__).resolve().parents[2] / "web"

# API routes CloudFront forwards to the HTTP API. They must match the routes
# added below; everything else is served from the site bucket.
API_PATHS = ("/manifest", "/file-url")


@jsii.implements(ILocalBundling)
class _LocalGoBuild:
    """Builds the Lambda with the local Go toolchain when one is installed,
    so synth and deploy don't need a running Docker daemon. Returning False
    tells CDK to fall back to the Docker bundling image instead."""

    def try_bundle(self, output_dir, *args, **kwargs):
        if shutil.which("go") is None:
            return False
        subprocess.run(
            ["go", "build", "-trimpath", "-ldflags=-s -w",
             "-o", os.path.join(output_dir, "bootstrap"), GO_PACKAGE],
            cwd=GO_SRC,
            env={**os.environ, **GO_BUILD_ENV},
            check=True,
        )
        return True


@jsii.implements(ILocalBundling)
class _LocalWebBuild:
    """Builds the frontend with the local npm and the existing node_modules
    (run `npm install` in web/ first), so synth and deploy don't need Docker.
    `npm run build` type-checks, then Vite writes straight into the asset
    directory. Vite reads .env.development.local only in dev mode, so the
    dev API URL never reaches this build."""

    def try_bundle(self, output_dir, *args, **kwargs):
        if shutil.which("npm") is None:
            return False
        subprocess.run(
            ["npm", "run", "build", "--", "--outDir", output_dir, "--emptyOutDir"],
            cwd=WEB_SRC,
            check=True,
        )
        return True


class DocSearchWebStack(Stack):
    """Read path for Doc Search: one Go Lambda behind an HTTP API (v2),
    serving GET /manifest and GET /file-url, and the React frontend in a
    private S3 bucket behind CloudFront. CloudFront also forwards the API
    routes, so the hosted app calls the API at its own origin.

    Everything here is read-only against the storage stack's bucket and
    table — the CLI remains the only write path.
    """

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        bucket: s3.IBucket,
        table: dynamodb.ITable,
        cors_origins: list[str],
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        code = lambda_.Code.from_asset(
            str(GO_SRC),
            # Only Go source affects the binary; keeping everything else out
            # of the asset hash avoids redeploying for README edits.
            exclude=[".*", "*.md", "*_test.go", "Dockerfile", "compose.yaml", "docsearch-cli"],
            bundling=BundlingOptions(
                local=_LocalGoBuild(),
                # Matches the CLI's Dockerfile and the module's `go 1.23`.
                image=DockerImage.from_registry("golang:1.23"),
                environment={**GO_BUILD_ENV, "GOCACHE": "/tmp/go-cache", "GOPATH": "/tmp/go"},
                command=[
                    "go", "build", "-trimpath", "-ldflags=-s -w",
                    "-o", "/asset-output/bootstrap", GO_PACKAGE,
                ],
            ),
        )

        api_fn = lambda_.Function(
            self,
            "ApiFunction",
            runtime=lambda_.Runtime.PROVIDED_AL2023,
            architecture=lambda_.Architecture.ARM_64,
            handler="bootstrap",
            code=code,
            memory_size=256,
            timeout=Duration.seconds(10),
            environment={
                "DOCSEARCH_TABLE": table.table_name,
                "DOCSEARCH_BUCKET": bucket.bucket_name,
            },
            # An explicit log group (rather than the one Lambda creates on
            # first invoke) is what lets retention be set and the group be
            # cleaned up with the stack. Logs are disposable, unlike the docs.
            log_group=logs.LogGroup(
                self,
                "ApiFunctionLogs",
                retention=logs.RetentionDays.ONE_MONTH,
                removal_policy=RemovalPolicy.DESTROY,
            ),
        )

        table.grant_read_data(api_fn)
        # The presigned URLs are signed with this role's credentials, so the
        # role itself needs s3:GetObject for them to work.
        bucket.grant_read(api_fn)

        # No authorizer: the docs aren't sensitive, and the unguessable URL
        # plus stage throttling is the guard. Throttling has to be set on an
        # explicit $default stage — HttpApi's auto-created one doesn't take it.
        api = apigw.HttpApi(
            self,
            "HttpApi",
            create_default_stage=False,
            cors_preflight=apigw.CorsPreflightOptions(
                allow_origins=cors_origins,
                allow_methods=[apigw.CorsHttpMethod.GET],
                allow_headers=["content-type"],
                max_age=Duration.hours(1),
            ),
        )
        stage = apigw.HttpStage(
            self,
            "DefaultStage",
            http_api=api,
            stage_name="$default",
            auto_deploy=True,
            # A markdown page with several images fires one /file-url call
            # per image at once, hence the burst headroom.
            throttle=apigw.ThrottleSettings(rate_limit=20, burst_limit=50),
        )

        integration = integrations.HttpLambdaIntegration("ApiIntegration", api_fn)
        for path in API_PATHS:
            api.add_routes(path=path, methods=[apigw.HttpMethod.GET], integration=integration)

        # --- Frontend hosting ---

        # Holds only build output, which every deploy re-uploads, so unlike
        # the docs bucket it is safe to delete along with the stack.
        site_bucket = s3.Bucket(
            self,
            "SiteBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        # The API as a CloudFront origin. Caching is off (presigned URLs
        # must be fresh, and the manifest changes on every sync), and every
        # viewer header except Host is forwarded along with the query string
        # (/file-url?path=…). API Gateway needs its own Host header.
        api_behavior = cloudfront.BehaviorOptions(
            origin=origins.HttpOrigin(
                f"{api.api_id}.execute-api.{self.region}.amazonaws.com",
            ),
            viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD,
            cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
            origin_request_policy=cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        )

        distribution = cloudfront.Distribution(
            self,
            "SiteDistribution",
            default_root_object="index.html",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(site_bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            ),
            additional_behaviors={path: api_behavior for path in API_PATHS},
            # North America and Europe edge locations only; the cheapest
            # class, and the reader is in the US.
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
        )

        site = s3deploy.Source.asset(
            str(WEB_SRC),
            # Only source affects the build; keeping the rest out of the
            # asset hash avoids rebuilding for unrelated changes.
            exclude=["node_modules", "dist", ".*", "*.md"],
            bundling=BundlingOptions(
                local=_LocalWebBuild(),
                # Fallback when npm isn't installed. Docker gets a clean copy
                # of the source, without node_modules, so it installs first.
                image=DockerImage.from_registry("node:24"),
                environment={"npm_config_cache": "/tmp/npm-cache"},
                command=[
                    "bash", "-c",
                    "npm ci && npm run build -- --outDir /asset-output --emptyOutDir",
                ],
            ),
        )

        s3deploy.BucketDeployment(
            self,
            "SiteDeployment",
            sources=[site],
            destination_bucket=site_bucket,
            # Each deploy invalidates CloudFront's cache so the new build
            # shows up right away instead of after the cache expires.
            distribution=distribution,
            distribution_paths=["/*"],
            # Browsers revalidate every file with the site (a cheap 304 when
            # unchanged), so a phone never keeps an old index.html after a
            # deploy. The hashed JS and CSS names already change per build.
            cache_control=[s3deploy.CacheControl.no_cache()],
            # The handler shells out to the AWS CLI, which used all of the
            # 128 MB default and took about 75 s per deploy. Lambda CPU
            # scales with memory, so this adds headroom and speed.
            memory_limit=512,
        )

        # The dev server's VITE_API_URL; the hosted app doesn't use it.
        CfnOutput(self, "ApiUrl", value=stage.url)
        CfnOutput(self, "SiteUrl", value=f"https://{distribution.distribution_domain_name}")

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
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk import aws_s3 as s3
from constructs import Construct

# The Go module that holds both the CLI and the Lambda entry point.
GO_SRC = Path(__file__).resolve().parents[2] / "go_files"

# Lambda build flags: a static linux/arm64 binary named `bootstrap`, which is
# what the provided.al2023 runtime executes.
GO_BUILD_ENV = {"GOOS": "linux", "GOARCH": "arm64", "CGO_ENABLED": "0"}
GO_PACKAGE = "./cmd/api-lambda"


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


class DocSearchWebStack(Stack):
    """Read path for Doc Search: one Go Lambda behind an HTTP API (v2),
    serving GET /manifest and GET /file-url. Frontend hosting (S3 +
    CloudFront) joins this stack later.

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
        for path in ("/manifest", "/file-url"):
            api.add_routes(path=path, methods=[apigw.HttpMethod.GET], integration=integration)

        CfnOutput(self, "ApiUrl", value=stage.url)

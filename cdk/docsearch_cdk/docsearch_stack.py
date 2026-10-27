from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
)
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_s3 as s3
from constructs import Construct


class DocSearchStack(Stack):
    """Storage layer for Doc Search: the S3 bucket that holds file content
    and the DynamoDB table that holds the manifest (path -> hash/metadata).

    The Go CLI talks to both of these directly via the AWS SDK — there's
    no Lambda or API Gateway in this stack yet. Those come later, once the
    read-only web frontend needs a way to list the manifest and fetch file
    content without holding AWS credentials itself.
    """

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        self.bucket = s3.Bucket(
            self,
            "DocsBucket",
            versioned=True,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            # Versioning keeps every overwritten or deleted object around as
            # a noncurrent version, so without this, renames and edits grow
            # storage forever. 30 days is the recovery window for anything
            # the CLI deletes or overwrites. Once those versions expire, the
            # leftover delete markers are cleaned up too.
            lifecycle_rules=[
                s3.LifecycleRule(
                    noncurrent_version_expiration=Duration.days(30),
                    expired_object_delete_marker=True,
                )
            ],
            # RETAIN means deleting the stack won't delete the bucket (or
            # its contents) by accident. This is personal document storage —
            # losing it because of a "cdk destroy" typo would be a bad day.
            # Switch to DESTROY only if you're experimenting and want
            # teardown to be complete and automatic.
            removal_policy=RemovalPolicy.RETAIN,
        )

        self.table = dynamodb.Table(
            self,
            "ManifestTable",
            partition_key=dynamodb.Attribute(
                name="path", type=dynamodb.AttributeType.STRING
            ),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            # Same reasoning as the bucket: the manifest is the only record
            # of what's supposed to exist. Don't let a stack teardown wipe
            # it silently.
            removal_policy=RemovalPolicy.RETAIN,
        )

        # Printed after `cdk deploy` — copy these into DOCSEARCH_BUCKET and
        # DOCSEARCH_TABLE for the CLI, rather than hardcoding names anywhere.
        CfnOutput(self, "BucketName", value=self.bucket.bucket_name)
        CfnOutput(self, "TableName", value=self.table.table_name)

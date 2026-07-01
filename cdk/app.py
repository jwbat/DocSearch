#!/usr/bin/env python3
import aws_cdk as cdk

from docsearch_cdk.docsearch_stack import DocSearchStack

app = cdk.App()

DocSearchStack(
    app,
    "DocSearchStack",
    # Uncomment and fill in if you want to pin the stack to a specific
    # account/region rather than relying on the AWS CLI's configured
    # default (via `aws configure` or AWS_PROFILE/AWS_REGION env vars).
    # env=cdk.Environment(account="123456789012", region="us-west-2"),
)

app.synth()

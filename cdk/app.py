#!/usr/bin/env python3
import aws_cdk as cdk

from docsearch_cdk.docsearch_stack import DocSearchStack
from docsearch_cdk.web_stack import DocSearchWebStack

# Pinned so a deploy can't land in whichever account/region the caller's
# credentials happen to point at. This is the `personal` profile's account,
# where DocSearchStack was first deployed.
ENV = cdk.Environment(account="559612528400", region="us-west-2")

# Browser origins allowed to call the API and read presigned URLs. The
# .local name is the Vite dev server as reached from other devices on the
# LAN (e.g. an iPhone); it survives DHCP handing the Mac a new IP. The
# CloudFront origin is added once frontend hosting exists.
FRONTEND_ORIGINS = [
    "http://localhost:5173",
    "http://jamess-macbook-pro.local:5173",
]

app = cdk.App()

storage = DocSearchStack(
    app,
    "DocSearchStack",
    env=ENV,
    cors_origins=FRONTEND_ORIGINS,
)

DocSearchWebStack(
    app,
    "DocSearchWebStack",
    env=ENV,
    bucket=storage.bucket,
    table=storage.table,
    cors_origins=FRONTEND_ORIGINS,
)

app.synth()

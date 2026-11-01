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
# LAN (e.g. an iPhone); it survives DHCP handing the Mac a new IP.
#
# The CloudFront origin is the hosted site (the SiteUrl output of
# DocSearchWebStack). It's written out rather than passed from that stack
# because the docs bucket lives in DocSearchStack, which the web stack
# already depends on; the reverse reference would be a cycle. The domain
# stays the same for the life of the distribution. The hosted app reaches the
# API through CloudFront at its own origin, so strictly only the docs bucket
# needs this entry.
FRONTEND_ORIGINS = [
    "http://localhost:5173",
    "http://jamess-macbook-pro.local:5173",
    "https://do5al0s1ozgt6.cloudfront.net",
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

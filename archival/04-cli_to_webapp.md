What changes?  nothing on the backend, everything on the client side 

**What doesn't change:** Lambda calls to Bedrock, S3, and DynamoDB are already using `config.LoadDefaultConfig` resolving to the Lambda execution role — that's true whether the request originated from the CLI or a browser.  
The Go SDK credential chain inside the Lambda is identical in both cases.  
This is a point worth being clear on, because it's easy to conflate "the user is using a web app now" with "the backend needs different credentials" — it doesn't.

**What actually changes:** the authentication leg between the *client* and API Gateway.

Right now, your CLI presumably either:
- holds your personal IAM credentials (`~/.aws/credentials` or an SSO profile) and signs requests with SigV4 directly, or
- has no client-side auth at all if you're calling API Gateway with a simple API key, since it's just you, on your own machine.

Either is fine for a CLI you alone run. Neither is fine in a browser — you can't embed long-lived IAM credentials or a secret API key in client-side JS; anyone who opens dev tools gets them.

The standard fix is **Amazon Cognito**, and specifically just the **User Pool** piece (you almost certainly don't need an Identity Pool here):

- Cognito User Pool handles login and issues short-lived JWTs (ID/access tokens) to the browser after authentication.
- API Gateway gets a **Cognito authorizer** attached to your routes — it validates the JWT on each request before it ever reaches your Lambda.
- Lambda code doesn't change at all. It still runs under its execution role, still talks to Bedrock/S3/DynamoDB the same way. The authorizer is a gate in front of it, not a credential the Lambda uses.

You'd only need an **Identity Pool** (the part that issues actual temporary AWS credentials to the browser) if the browser itself needed to call AWS services directly — e.g., uploading straight to S3 from JS without going through your Lambda. Given your design routes everything through API Gateway → Lambda, you don't need that.

Two other small things that come with the web-app jump:
- **CORS** — API Gateway and your Lambda responses need the right `Access-Control-Allow-Origin` headers, which a CLI never had to think about since there's no browser same-origin policy involved.
- If it's just for you (not multi-user), you could skip Cognito's account-management overhead entirely and use a much simpler scheme — a Lambda authorizer checking a single shared secret/bearer token. Less "proper," but proportionate if this never needs to support more than one user.

So: budget for Cognito + an authorizer + CORS config if you want it done the standard way, but the Go/Bedrock code you already planned doesn't need to change at all.

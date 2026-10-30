# CDK tour

A step-by-step walkthrough of the DocSearch CDK app, from general concepts down to
details worth knowing. Questions asked along the way are kept with the step they
came up in.

**Approach:** read the Python (`app.py`, `docsearch_cdk/*.py`) as the source of
truth, and open the synthesized templates to see what a given line turned into.

**Getting the templates:** `app.py` defines two stacks, so a bare `cdk synth`
won't print a template. It only prints a hint, and that goes to stderr, which is
why `cdk synth > template.yaml` produced an empty file. To get one file per stack:

```
cdk synth DocSearchStack    > storage.yaml
cdk synth DocSearchWebStack > web.yaml
```

The same templates also exist as JSON in `cdk.out/` after any synth.

---

## Step 1: The big picture (CDK is a compiler for CloudFormation)

AWS itself doesn't know anything about CDK. What AWS runs is **CloudFormation**,
a service that takes a template (a JSON/YAML list of resources) and creates,
updates or deletes real resources until they match it. CDK is a way to *produce*
those templates with a real programming language. Working with it happens in
three phases:

| Phase | What runs | Output |
|---|---|---|
| **1. Your program** | `python3 app.py` (set by the `"app"` key in `cdk.json`) | An in-memory tree of objects |
| **2. Synth** | `app.synth()` on the last line of `app.py` | Templates and other files written to `cdk.out/` |
| **3. Deploy** | `cdk deploy` uploads the templates and hands them to CloudFormation | Real resources in account 559612528400 / us-west-2 |

Phases 1 and 2 are offline. Your Python never talks to AWS: it only *describes*
what should exist. That's why `cdk synth` is safe to run as often as you like,
and only `cdk deploy` and `cdk destroy` touch anything real.

The three kinds of object in that tree, all visible in `app.py`:

- **App** (`cdk.App()`): the root of the tree. There's one per program.
- **Stack** (`DocSearchStack`, `DocSearchWebStack`): **one stack = one
  CloudFormation template**, deployed and rolled back as a unit. There are two
  because storage (precious, rarely changes) and the web read path (disposable,
  changes often) have different lifecycles.
- **Construct**: everything inside a stack (`s3.Bucket`, `lambda_.Function`, …).
  Every construct is created with `(scope, id, ...)`, where *scope* is its parent
  in the tree. That's why `self` is always the first argument inside the stacks:
  "attach this bucket to me."

In `app.py`, `storage.bucket` and `storage.table` are passed into the web stack:
an ordinary Python object passed between stacks, which CDK turns into a
cross-stack link between the two templates.

### Q: So the web stack depends on the storage stack, but the storage stack doesn't need to know anything about the web stack?

Yes, that's right. The dependency only goes one way, and you can see it in the
synthesized templates.

**In the Python**, `DocSearchWebStack` receives `bucket` and `table` as
constructor arguments. `DocSearchStack` takes no arguments that mention the web
stack, so it has no idea the web stack exists.

**In the templates**, CDK notices that a construct from one stack is being used
in another and writes both halves of a CloudFormation cross-stack reference:

- `DocSearchStack.template.json` gets four **Exports**: the bucket's name and
  ARN, and the table's name and ARN. They have generated names like
  `DocSearchStack:ExportsOutputRefDocsBucketECEA003FBE2AA417`.
- `DocSearchWebStack.template.json` reads them with **`Fn::ImportValue`** in five
  places: the Lambda's environment variables (names) and its IAM policy (ARNs).

None of this was written by hand. It came from `table.table_name` and
`bucket.grant_read(...)` being called on objects owned by another stack.

**What the one-way link means in practice:**

1. **Deploy order is enforced.** `cdk deploy --all` deploys storage first, and
   deploying only the web stack also deploys storage first unless you pass
   `--exclusively`. CloudFormation won't let an import resolve against an export
   that doesn't exist yet.
2. **You can change the web stack freely.** Redeploying it, or even destroying
   it, leaves storage untouched. That's the payoff of the split: the risky churn
   (Lambda code, API routes, and later CloudFront) is kept away from the
   documents.
3. **The reverse direction is locked.** CloudFormation won't let
   `DocSearchStack` delete or change an export while another stack imports it.
   Usually this protects you. It bites if you rename or replace the bucket or
   table, or stop using one of them from the web stack. An error like *"Export …
   cannot be deleted as it is in use by DocSearchWebStack"* means this. The fix
   is a two-step deploy.

These are "strong" references because of
`"@aws-cdk/core:defaultCrossStackReferences": "strong"` in `cdk.json`. That's the
standard mechanism, and it's the right choice for two stacks in the same account
and region.

---

## Step 2: The shape of `DocSearchStack`, and how resources get their identity

`docsearch_stack.py` has just **two constructs and two outputs**. Here's what
that turned into in `cdk.out/DocSearchStack.template.json`:

| Python (line) | Template resource (logical ID) | CloudFormation type |
|---|---|---|
| `s3.Bucket(self, "DocsBucket", …)` (31) | `DocsBucketECEA003F` | `AWS::S3::Bucket` |
| `dynamodb.Table(self, "ManifestTable", …)` (66) | `ManifestTable24A5E2D7` | `AWS::DynamoDB::Table` |
| `CfnOutput(…)` ×2 (81–82) | `BucketName`, `TableName` outputs | — |
| *(automatic)* | `CDKMetadata` | version info that CDK reports to AWS (harmless) |
| *(automatic)* | 4 `ExportsOutput…` outputs | the cross-stack exports |

### Concept 1: L2 constructs ("smart" wrappers)

`s3.Bucket` and `dynamodb.Table` are **L2 constructs**. CDK has three levels:

- **L1** (`CfnBucket`, `CfnTable`): a 1:1 mirror of the CloudFormation resource,
  with no defaults and no help.
- **L2** (`Bucket`, `Table`): what this project uses. They have sensible
  defaults, typed options like `Duration.days(30)` instead of raw numbers, and
  helper methods such as `grant_read()`.
- **L3** ("patterns"): bundles of several resources, e.g. "API Gateway + Lambda"
  in one call. None are used here.

Here each L2 happened to produce exactly one resource. That isn't always the
case: one `lambda_.Function` quietly produces an IAM role too.

### Concept 2: Three different names for one thing

1. **Construct ID** (`"DocsBucket"`): the name you choose. It only has to be
   unique within its parent.
2. **Logical ID** (`DocsBucketECEA003F`): CDK's ID plus a hash of its path in the
   tree. This is how **CloudFormation tracks the resource across deploys**.
3. **Physical name**: the real bucket name in AWS. None was set, so
   CloudFormation generated it, something like
   `docsearchstack-docsbucketecea003f-abc123xyz`. That's why the `CfnOutput`s
   exist: they print the generated names after a deploy so you can put them in
   `DOCSEARCH_BUCKET` and `DOCSEARCH_TABLE`.

### The detail to be aware of

**CloudFormation treats a changed logical ID as a different resource.** If you
rename `"DocsBucket"` to `"DocumentsBucket"`, or move the bucket inside another
construct, the logical ID changes. CloudFormation then concludes that the old
resource was removed and a new one added. Because of `RETAIN` (which appears in
the template as `DeletionPolicy: Retain`), the old bucket isn't deleted. It's
**orphaned**: it still exists with all the files, but the stack no longer manages
it. Meanwhile you get a brand-new, empty bucket with a new name, and the
cross-stack lock would block that deploy anyway.

Rule of thumb: **treat construct IDs of stateful resources as permanent**, even
if they look like they'd be harmless to tidy up.

### Q: The physical names won't change on later deploys, right? Changing env vars each time would be inconvenient.

Right. The name is generated **once, when CloudFormation first creates the
resource**. After that it stays the same on every deploy, whether you change
versioning, lifecycle rules, CORS or billing mode. Those are all in-place
updates to the same bucket or table.

The name only changes if the resource is **replaced**, which happens in two
ways:

1. **Its logical ID changes** (the rename or move case above).
2. **You change a property that AWS can't modify in place.** Each CloudFormation
   property is documented with one of three update behaviors: "No interruption",
   "Some interruption" or "Replacement". The ones to watch here:
   - **Table:** `partition_key`, or adding a sort key. DynamoDB can't change a
     table's key schema, so CloudFormation builds a new table.
   - **Bucket or table:** setting an explicit `bucket_name=` or `table_name=`
     later.
   - Most other bucket and table settings update in place.

If a replacement does happen, `RETAIN` (as `UpdateReplacePolicy: Retain`) keeps
the old resource and its data, orphaned. The new resource gets a new generated
name, and the env vars would then point at the old one.

**The habit that protects you:** run `cdk diff` before every `cdk deploy`. It
compares the synthesized template with what's deployed, and any change that
forces a replacement is flagged with the words "requires replacement". If you
see that on the bucket or table, stop and rethink the change.

The two consumers differ here:

- **Go CLI:** reads the names from env vars set by hand, so a replacement would
  break it until they were updated.
- **Lambda:** gets the names through `Fn::ImportValue` (the cross-stack link).
  If a name ever changed, the next web-stack deploy would pick it up
  automatically.

---

## Step 3a: Versioning and the lifecycle rule

`docsearch_stack.py:34` and `:42–47`

```python
versioned=True,
lifecycle_rules=[s3.LifecycleRule(
    noncurrent_version_expiration=Duration.days(30),
    expired_object_delete_marker=True,
)]
```

**Versioning:** overwriting a file doesn't destroy the old content. The old
content becomes a **noncurrent version** of the same key.

**A delete is a soft delete:** S3 adds a **delete marker** on top, and the data
is still there underneath as a noncurrent version.

**The lifecycle rule** sets how long that undo lasts:
- Noncurrent versions are deleted **30 days** after they become noncurrent.
- After that, the leftover delete marker has nothing under it, and
  `expired_object_delete_marker` removes it.

**To recover a file:** in the S3 console, turn on "Show versions" and delete the
delete marker, or copy an old version back over the current one.

In the template, `Duration.days(30)` becomes `NoncurrentDays: 30`, and CDK adds
`Status: Enabled`.

---

## Step 3b: Public-access block, encryption and CORS

`docsearch_stack.py:35–36` and `:51–57`

**`block_public_access=BLOCK_ALL`**: no bucket policy or ACL can make anything
public. In the template this becomes four `true` flags.

- This doesn't conflict with presigned URLs. A presigned URL is a request signed
  with the **Lambda role's** credentials, so it's private access handed to the
  browser for a short time, not public access.

**`encryption=S3_MANAGED`**: everything is encrypted at rest (`AES256`), with
keys S3 manages.

- It's free and invisible. The alternative, a KMS key, would mean every reader
  also needs `kms:Decrypt`.

**`cors=[…]`**: lets browser JavaScript from the two origins `GET` objects.

- It only matters for `fetch()`, which is how the frontend reads markdown to
  render it. A plain `<img src=…>` doesn't need CORS.
- **Phase 6 reminder:** once CloudFront exists, add its origin to
  `FRONTEND_ORIGINS` in `app.py`. That one list feeds both the bucket's CORS and
  the API's.

### Q: What's an ACL?

An **Access Control List** is S3's original permission system, older than IAM
policies. Each bucket and each object carries its own small list of grants, such
as "AllUsers: READ", which makes that object public.

- AWS now recommends leaving ACLs off and using policies only. New buckets have
  them disabled by default.
- `BLOCK_ALL` covers both mechanisms. Two of its four flags block public ACLs,
  and the other two block public bucket policies, so neither route can make
  anything public.

### Q: Why are the objects encrypted?

Mostly because S3 does it anyway. Since January 2023, S3 encrypts every new
object with S3-managed keys by default, so that line just makes the default
explicit.

- What it protects against is AWS-side exposure, such as disks or backups
  leaving a data center.
- It does **not** protect against anyone who has `s3:GetObject`. Decryption is
  automatic for any authorized request, including a presigned URL.
- So for this project it isn't really a security control. It's free, and
  there's no reason to turn it off.

### Q: Where is the presigned URL generated, and who receives it?

- **Generated:** in the Lambda, by the `GET /file-url` handler at
  `go_files/internal/api/api.go:141`. Before signing anything, it checks the
  manifest and returns a 404 if the path is missing or soft-deleted, so the API
  never signs arbitrary keys.
- **How:** signing is a local calculation. The Lambda makes no call to S3: it
  signs the URL with its role's credentials and sets it to expire after
  **5 minutes** (`URLExpiry`, `api.go:25`).
- **Received by:** the browser. The URL goes back as JSON (`{url, expiresIn}`)
  to the frontend's `web/src/api.ts:64`.
- **Used by:** the browser again. It fetches the file **directly from S3**, so
  the file content never passes through the Lambda or API Gateway.
- **Checked by:** S3, when the request arrives. It checks the signature and the
  expiry, and whether the signing role is allowed `s3:GetObject`. That last check
  is why `bucket.grant_read(api_fn)` exists in the web stack.

### Q: What does the Go Lambda do, at a high level?

The Go Lambda is the backend of the website. It runs only when the browser calls
the API, and it only reads data, never writes it. It answers two questions.

**`GET /manifest`: "What files are there?"**
- It reads (scans) the entire DynamoDB table.
- It drops soft-deleted entries and sorts the rest by path.
- It returns JSON with path, sha256, size, content type and modified time for
  each file. The frontend builds its file list and search from this.

**`GET /file-url?path=…`: "Let me read this file."**
- It checks the manifest to confirm the file exists and isn't soft-deleted.
- It returns a presigned S3 URL that's valid for 5 minutes (see the previous
  question). The browser then fetches the file directly from S3.

**How it's put together:**
- `cmd/api-lambda/main.go` reads `DOCSEARCH_TABLE` and `DOCSEARCH_BUCKET` from
  its environment. The web stack sets those through the cross-stack imports.
- At startup it creates its AWS clients, then hands each request to
  `internal/api/api.go`, which picks the right handler for the path.
- It's in the same Go module as the CLI and reuses the CLI's `internal/manifest`
  code, so both read the table the same way.

**The split of responsibilities:**
- **CLI:** the only thing that writes. It syncs local files to S3 and DynamoDB.
- **Lambda:** read-only access for the browser. It never handles file content
  itself; it only hands out short-lived permission to fetch it.

---

## Step 3c: The table

`docsearch_stack.py:66–77`

| Python | Template |
|---|---|
| `partition_key=Attribute("path", STRING)` | `KeySchema: path HASH` **and** `AttributeDefinitions: path S` |
| `billing_mode=PAY_PER_REQUEST` | `BillingMode: PAY_PER_REQUEST` |

**Only the key is declared.** DynamoDB is schemaless apart from the key, so
sha256, size, content type and the soft-delete flag aren't in the template at
all. The CLI simply writes them. CloudFormation requires an `AttributeDefinitions`
entry for each key attribute, and the L2 filled that in from `partition_key`.

**`path` is the whole key**, with no sort key: one row per file, looked up by
its path. As covered in Step 2, the key can never change without replacing the
table.

**On-demand billing:** you pay per read and write, with no capacity to plan. At
personal scale that's pennies or nothing.

**There's no backup.** The bucket has a 30-day undo, but point-in-time recovery
is off for the table (it's off by default). `RETAIN` protects against
`cdk destroy`, not against a bad sync writing wrong rows. It can be turned on
with one argument if you ever want it:
`point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(point_in_time_recovery_enabled=True)`.

---

## Step 4a: `DocSearchWebStack` at a glance

`web_stack.py` has about five constructs, which synthesize to **11 resources**.
A request flows through them like this:

```
browser ──► HTTP API ──► Stage ($default) ──► Route (GET /manifest, GET /file-url)
                                                   │
                                              Integration
                                                   │
                                                   ▼
                                           Lambda function ──► DynamoDB / S3 (read)
                                                   │
                                               Log group
```

How the Python maps to the template:

| Python | Resources it produced |
|---|---|
| `lambda_.Function(…)` (90) | `AWS::Lambda::Function`, **plus an `IAM::Role`** (generated automatically) |
| `logs.LogGroup(…)` (106) | `AWS::Logs::LogGroup` |
| `table.grant_read_data` / `bucket.grant_read` (114–117) | `IAM::Policy`, attached to that role |
| `apigw.HttpApi(…)` (122) | `ApiGatewayV2::Api` |
| `apigw.HttpStage(…)` (133) | `ApiGatewayV2::Stage` |
| `HttpLambdaIntegration` + `add_routes` loop (144–146) | 1 `Integration`, 2 `Route`s, **2 `Lambda::Permission`s** |
| `CfnOutput("ApiUrl")` | the API's URL, printed after a deploy |

The difference from the storage stack: there, each L2 produced one resource.
Here the L2s **generate supporting resources you never wrote**: the role, the
policy and the permissions. Those are mostly about *who is allowed to call
whom*, which comes next.

### Q: Where, when, and by whom is the URL the frontend uses generated?

This is the **API's** URL, the one the frontend calls. (The frontend's *own*
site URL doesn't exist yet. It will come from CloudFront once hosting is added.)

**By whom:** AWS (API Gateway), not CDK. **When:** the first time
`cdk deploy` creates the `HttpApi`. API Gateway assigns it a random ID such as
`a1b2c3d4e5`, and the URL is built from that ID.

At synth time CDK doesn't know the ID, so the template contains a formula
instead of a value:

```json
"ApiUrl": {"Fn::Join": ["", ["https://", {"Ref": "HttpApiF5A9A8A7"},
          ".execute-api.us-west-2.", {"Ref": "AWS::URLSuffix"}, "/"]]}
```

CloudFormation fills in the `Ref` at deploy time, giving
`https://a1b2c3d4e5.execute-api.us-west-2.amazonaws.com/`. This is the same
pattern as the generated bucket name. It's an example of a **token**: a
placeholder in your Python, such as `stage.url` or `bucket.bucket_name`, that is
only resolved during deployment.

**Stability:** like the bucket name, the URL stays the same on every redeploy
unless the `HttpApi` resource is replaced (for example by changing its construct
ID).

**How it reaches the frontend:** by hand, for now.
1. `cdk deploy` prints the `ApiUrl` output. It can also be fetched later with
   the `describe-stacks` command in `web/.env.example`.
2. You paste it into `web/.env.local` as `VITE_API_URL`.
3. `web/src/api.ts:30` reads `import.meta.env.VITE_API_URL`. Vite inlines the
   value **at build time**, so it ends up as plain text in the built JS. That's
   fine, because it isn't a secret: anyone using the site can see which API it
   calls.

### Q: Can the URL be made shorter? Or would a service like TinyURL be needed?

**The default URL can't be shortened.** The format
`https://<10-char-id>.execute-api.<region>.amazonaws.com/` is fixed, and the ID
is assigned at random.

**Does its length matter?** Probably not: nobody types the API URL. It's set
once in `VITE_API_URL` and only code ever uses it. The URL people actually see
is the **site's** URL, which will be something like
`https://d1abc2defghij.cloudfront.net` once hosting exists. That one has the
same problem and the same fix.

**The real fix is a custom domain.** For example, `docs.yourname.com` for the
site and `api.yourname.com` for the API. That requires:
- a domain you own (Route 53 or any registrar, roughly $10–15 a year),
- a free TLS certificate from ACM (AWS Certificate Manager),
- a few CDK constructs: `DomainName` for the API, or `domain_names=` on the
  CloudFront distribution, plus a DNS record.

**A neater option for Phase 6:** route `/api/*` through CloudFront to API
Gateway. The frontend then calls `/api/manifest` on its **own** origin, so the
API URL drops out of the frontend config entirely, and the API's CORS setup
becomes unnecessary. (The bucket CORS is still needed, since presigned URLs
point straight at S3.)

**URL shorteners:** these work for a URL a person bookmarks or shares (a link to
the site), because the browser simply follows the redirect. They're a bad fit
for the API. Each call would add a redirect hop, and browsers refuse to follow
redirects on CORS preflight requests.

---

## Step 4b: The Lambda's IAM role and policy

Every Lambda runs **as an IAM role**, which is its identity in AWS. You never
wrote `iam.Role(…)`: `lambda_.Function` created `ApiFunctionServiceRole` for you.
A role has two halves:

**1. Trust policy: who may *become* this role**

```json
"Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"
```

Only the Lambda service can assume it. When the function runs, Lambda hands it
temporary credentials for the role, and the Go SDK picks them up automatically.
That's why `main.go` has no keys in it.

**2. Permissions: what the role may *do***

- **`AWSLambdaBasicExecutionRole`** (an AWS-managed policy, added automatically):
  permission to write logs to CloudWatch.
- **`ApiFunctionServiceRoleDefaultPolicy`**: this is what the two `grant_*`
  calls (`web_stack.py:114–117`) produced:

| Call | Actions | On |
|---|---|---|
| `table.grant_read_data(api_fn)` | `GetItem`, `Query`, `Scan`, `BatchGetItem`, … | the table's ARN |
| `bucket.grant_read(api_fn)` | `s3:GetObject*`, `s3:GetBucket*`, `s3:List*` | the bucket ARN **and** `bucket/*` |

**Details to be aware of:**

- **`grant_*` is the idiomatic CDK way to do IAM.** You say *who* gets *what
  kind* of access, and the L2 picks the action list and the ARNs. In this case
  the ARNs arrive through `Fn::ImportValue` from the storage stack.
- **There are no write actions anywhere.** No `PutItem` and no `PutObject`, so
  "the Lambda is read-only" is enforced by IAM, not just by the Go code.
- **The bucket needs two ARNs:** the bucket itself (for `List*`) and `bucket/*`,
  meaning the objects (for `GetObject`). Forgetting `/*` is a classic mistake
  when writing IAM by hand, and the grant takes care of it.
- **The role is what signs the presigned URLs** (Step 3b), so removing
  `bucket.grant_read` would break the URLs without any error at signing time.
  S3 would return 403 only when the browser used them.

### Q: What is the `jsii` library, and what does `@jsii.implements(ILocalBundling)` do?

**What jsii is:** CDK is written in **TypeScript**. jsii is the tool that turns
that one TypeScript codebase into libraries for Python, Java, .NET and Go. The
Python `aws_cdk` package isn't a rewrite of CDK. It's a thin layer that, when
imported, **starts a Node.js process in the background** and forwards every call
to the real JavaScript CDK running there. That's why CDK needs Node even in a
Python project.

So `s3.Bucket(self, "DocsBucket", …)` in Python really creates a JavaScript
`Bucket` object in that Node process, and the Python object is a handle to it.

**Why the decorator is needed:** usually calls go Python → JS. Bundling goes the
other way:

1. `BundlingOptions(local=_LocalGoBuild(), …)` hands a **Python** object to
   CDK.
2. During synth, the JavaScript side wants to call `tryBundle(outputDir,
   options)` on it, a method defined by the TypeScript interface
   `ILocalBundling`.
3. Python has no real interfaces, so jsii needs to be told that this Python class
   fulfils that interface and that JS may call back into it.
   `@jsii.implements(ILocalBundling)` does exactly that: it registers the class
   so jsii can pass it to JS and route `tryBundle` back to the Python method.

**Details to be aware of:**

- **Names are converted:** JS calls `tryBundle`, and jsii maps it to Python's
  `try_bundle`. The method has to use that exact snake_case name.
- **The signature:** JS passes `(outputDir, options)`. `*args, **kwargs` absorbs
  `options`, which this code doesn't use.
- **Without the decorator,** synth fails with a jsii error saying the object
  doesn't implement the expected interface.
- **What it buys here:** `try_bundle` runs `go build` on the Mac and writes
  `bootstrap` into `output_dir`, returning `True`. If `go` isn't installed it
  returns `False`, and CDK falls back to the `golang:1.23` Docker image, which is
  why Colima can usually stay off. Asset bundling gets its own step later.

---

## Step 4c: How API Gateway is allowed to call the Lambda

`web_stack.py:144–146`: three lines that produced five resources.

### Two directions of permission

Step 4b was about what **the Lambda** may do: an identity-based policy attached
to its role. This step is the reverse: **who may invoke the Lambda**. That's a
*resource-based* policy attached to the function itself, written as
`AWS::Lambda::Permission`:

```json
"Action": "lambda:InvokeFunction",
"Principal": "apigateway.amazonaws.com",
"SourceArn": "arn:aws:execute-api:us-west-2:559612528400:<api-id>/*/*/manifest"
```

In words: "API Gateway may invoke this function, but only on behalf of *this*
API, for the `/manifest` path." The `SourceArn` ends in `stage/method/path`,
and the two `*`s mean any stage and any method. There's one permission per
route, so there are two. Without them API Gateway would get "access denied", and
the browser would see a 500.

### Integration and routes

- **Integration** (one, shared): "send requests to this Lambda." Its type is
  `AWS_PROXY` with `PayloadFormatVersion: 2.0`, so API Gateway forwards the
  *whole* HTTP request as an event, and the Lambda returns the whole response
  (status, headers, body). That's the `events.APIGatewayV2HTTPRequest` and
  `Response` types in the Go code.
- **Routes** (two): `RouteKey: "GET /manifest"` and `"GET /file-url"`, each with
  `Target: integrations/<id>` pointing at that shared integration.

**Details to be aware of:**

- **Routing happens twice.** API Gateway only accepts these two routes and
  answers anything else with 404 itself, without invoking the Lambda. The Go
  `Handle` switch then routes again between the two. Adding an endpoint means
  adding it in **both** places: the `for path in (…)` tuple and the Go switch.
- **The integration's logical ID says `GETmanifest`** even though both routes
  use it. CDK names it after the first route it's attached to. It's only a
  label.
- **`AuthorizationType: NONE`**: there's no login, which is deliberate according
  to the comment at `web_stack.py:119`. Throttling (a later step) is what guards
  the API instead.

### Q: Where is that permission granted in `web_stack.py`, or is it automatic?

It's automatic. No line in `web_stack.py` mentions it.

- `api.add_routes(…, integration=integration)` (line 146) creates the route
  and then calls the integration's internal `bind()` method, passing it the
  route.
- `HttpLambdaIntegration.bind()` does two things: it creates the shared
  `Integration` resource (only the first time), and it adds a
  `Lambda::Permission` scoped to **that route's** path.
- The loop calls `add_routes` twice, so `bind()` runs twice, producing one
  integration and two permissions. That's also why the permissions' logical IDs
  contain `…ApiIntegrationPermission`.

Compare this with Step 4b. The Lambda's access to S3 and DynamoDB had to be
requested explicitly with `grant_*`, because CDK can't guess which resources
your code uses. Here, connecting an API route to a Lambda only works if
API Gateway can invoke it, so the integration construct adds the permission
itself.

The general pattern: **L2s add whatever permissions are implied by the
connection you described.** Permissions they can't infer, you grant yourself.

---

## Step 4d: The function's settings

`web_stack.py:90–102`

```python
runtime=lambda_.Runtime.PROVIDED_AL2023,
architecture=lambda_.Architecture.ARM_64,
handler="bootstrap",
memory_size=256,
timeout=Duration.seconds(10),
environment={"DOCSEARCH_TABLE": …, "DOCSEARCH_BUCKET": …},
```

**`PROVIDED_AL2023`**: an "OS-only" runtime (Amazon Linux 2023) with no
language installed. Lambda simply runs an executable named **`bootstrap`** from
your zip. Go compiles to a single binary, so this is the standard way to run Go
on Lambda.
- `handler="bootstrap"` is required by the API but **ignored** by provided
  runtimes. It's set to the binary's name by convention.

**`ARM_64`**: runs on Graviton processors, which cost about 20% less than x86.
- This **must match `GOARCH=arm64`** in `GO_BUILD_ENV` (line 29). If they
  disagree, the deploy succeeds but every invocation fails with an
  `exec format error`.

**`memory_size=256`** (MB): Lambda allocates **CPU in proportion to memory**,
so this setting is also the CPU dial. 256 is plenty for JSON plus a DynamoDB
scan. You're billed for memory × duration.

**`timeout=10s`**: the Lambda is killed after this. The API Gateway HTTP API has
its own hard limit of 30s, so anything up to that is usable. The one thing that
grows with your data is the full-table scan behind `/manifest`.

**`environment`**: how the binary learns the table and bucket names (read in
`main.go`). The values are the `Fn::ImportValue` tokens, resolved at deploy
time. Environment variables are visible to anyone with console access, so they
are fine for names but never for secrets.

---

## Step 4e: The log group

`web_stack.py:103–111`

Anything the Go code writes with `log.Printf`, plus Lambda's own
start/end/duration lines, goes to a **CloudWatch Logs log group**.

**Without this block,** Lambda creates `/aws/lambda/<function-name>` by itself
the first time the function runs. That group:
- is created outside CloudFormation, so the stack doesn't know it exists,
- keeps logs **forever** (and you pay to store them),
- is left behind after `cdk destroy`.

**With it:**

| Python | Template |
|---|---|
| `logs.LogGroup(self, "ApiFunctionLogs", …)` | `AWS::Logs::LogGroup` |
| `retention=ONE_MONTH` | `RetentionInDays: 30` |
| `removal_policy=DESTROY` | `DeletionPolicy: Delete` |
| `log_group=` on the function | `LoggingConfig: {LogGroup: Ref …}` on the function |

**Details to be aware of:**

- **`DESTROY` here versus `RETAIN` on the storage stack** is deliberate: logs
  are disposable, while documents are not.
- **The name is generated,** like the bucket's, so it **won't** be
  `/aws/lambda/…`. To find it, open the function in the console → Monitor →
  "View CloudWatch logs", or look at the log group in the stack's Resources tab.
- **Where to look when the API returns 500:** `internalError(…)` in `api.go`
  logs the underlying error here, and the browser only ever sees a generic
  message.

---

## Step 4f: Asset bundling (how the Go code becomes the Lambda's zip)

`web_stack.py:24–49` and `:73–88`

### Concept: assets

A CloudFormation template can't contain a binary. It can only **point at a zip
file in S3**. CDK's word for "a local file or directory that has to be uploaded
somewhere before deploy" is an **asset**. The template ends up holding only
this:

```json
"Code": {"S3Bucket": "cdk-hnb659fds-assets-559612528400-us-west-2",
         "S3Key":    "33b7d3b0…5f6.zip"}
```

That bucket was created by **`cdk bootstrap`**, a one-time setup stack (named
`CDKToolkit`) that every CDK account and region needs. `hnb659fds` is its
default qualifier.

### What happens, in order

1. **Synth:** CDK hashes the source directory, which is `go_files/` minus the
   `exclude` patterns. That hash (`33b7d3b0…`) becomes the asset's ID.
2. **Bundle**, if that hash hasn't been built before:
   - First it tries **local bundling**: `_LocalGoBuild.try_bundle` runs
     `go build` with `GOOS=linux GOARCH=arm64 CGO_ENABLED=0` and writes
     `bootstrap` into `cdk.out/asset.33b7d3b0…/`.
   - If `go` isn't on the PATH, it returns `False`, and CDK runs the same build
     inside the `golang:1.23` Docker image instead (the `image=` and `command=`
     arguments).
3. **Deploy:** CDK zips that directory, uploads it to the assets bucket under
   its hash, and then CloudFormation updates the function to point at it.

---

## Step 4g: Asset bundling, details to be aware of

- **The hash is the change detector.** Same source means the same hash: no
  rebuild, no upload and no Lambda update. That's why `exclude` lists `*.md` and
  `*_test.go`, so editing a README or a test doesn't redeploy the function.
  **The flip side:** if the hash doesn't change, the code doesn't either, so a
  change that lives *outside* `go_files/` won't trigger a rebuild.
- **The build flags explained:** `CGO_ENABLED=0` produces a static binary with
  no C library dependencies, so it runs regardless of what's installed on the
  Lambda OS. It also makes cross-compiling from the Mac straightforward.
  `-trimpath` strips
  local paths from the binary. `-ldflags=-s -w` drops debug symbols to make it
  smaller.
- **`cdk.out/asset.*` is a cache.** The `bootstrap` binary there (about 16 MB)
  was built on Oct 27 and has been reused ever since, because the source hash
  hasn't changed.
- **Synthesizing one stack skips bundling for the other.** After
  `cdk synth DocSearchStack`, the web stack's asset entry in
  `DocSearchWebStack.assets.json` points at raw `go_files/` instead of the built
  output. That's expected. `cdk deploy` always synthesizes again and bundles
  whatever it is deploying.

### Q: What is meant by "OS-only runtime"?

Lambda has two kinds of runtime.

**Managed runtimes** (`python3.13`, `nodejs22.x`, `java21`, …) come with the
language installed, plus a small program from AWS that does the Lambda
plumbing. You upload source, name a function in `handler=` (e.g.
`app.lambda_handler`), and AWS's program calls it for each request.

**OS-only runtimes** (`provided.al2023`) give you only the operating system:
Amazon Linux 2023 with no language installed. Lambda starts **your executable**,
which must be named `bootstrap`, and *your program* does the plumbing itself:

1. ask Lambda's Runtime API (a local HTTP endpoint) for the next event,
2. handle it,
3. post the response back, then repeat.

In this project, that loop is `lambda.Start(srv.Handle)` in
`cmd/api-lambda/main.go`. The `aws-lambda-go` library implements it, so you only
write `Handle`. This is also why `handler=` is ignored: Lambda doesn't call a
function by name, it just runs `bootstrap`.

**Why Go uses it:** Go compiles to a native binary, so there's no interpreter to
supply. AWS retired its old `go1.x` managed runtime in 2023, and OS-only is now
the way to run Go (and Rust, C++, …) on Lambda. A bonus is fast cold starts,
since there's no interpreter to boot.

### Q: Are the flags enough to build the binary locally for Lambda's OS, or does it need Docker?

**The flags are enough.** Go cross-compiles natively: every Go installation can
build for every supported OS and CPU. `GOOS=linux GOARCH=arm64` tells it to
build for Lambda's target instead of the Mac (`darwin/arm64`). Both are ARM, but
the OS differs, so `GOOS` is still needed.

**`CGO_ENABLED=0` is what makes that hold.** With cgo, `go build` would also need
a C compiler and C libraries *for Linux*, which a Mac doesn't have. That's the
case where Docker (a real Linux environment) becomes necessary. This project is
pure Go, so it doesn't need it.

**So Docker here is only a fallback** for machines without Go installed. It
isn't required for correctness.

**One difference to be aware of:** the local build uses whichever Go version is
installed (currently 1.26.1), while the Docker fallback uses `golang:1.23`. The
`go 1.23` line in `go.mod` is a *minimum*, so both work. The binaries just
aren't byte-identical, and that only matters if you care about reproducible
builds.

---

## Step 4h: The HTTP API and its CORS settings

`web_stack.py:122–132`

### HTTP API (v2), not REST API (v1)

API Gateway has two products. `apigw.HttpApi` (the `aws_apigatewayv2` module)
is the newer **HTTP API**: about 70% cheaper per request, lower latency, and
simpler. The older **REST API** has extras such as API keys, usage plans and
request validation, none of which this project needs. In the template this is
`ProtocolType: HTTP`. (The other v2 option is `WEBSOCKET`.)

`create_default_stage=False` is explained in the next step.

### CORS

The browser loads the page from `localhost:5173` and calls
`<id>.execute-api…amazonaws.com`, which is a different origin. The browser only
lets the page read the response if the API answers with matching
`Access-Control-Allow-*` headers.

| Python | Template (`CorsConfiguration`) |
|---|---|
| `allow_origins=cors_origins` | `AllowOrigins`: your two dev origins |
| `allow_methods=[GET]` | `AllowMethods: GET` |
| `allow_headers=["content-type"]` | `AllowHeaders: content-type` |
| `max_age=Duration.hours(1)` | `MaxAge: 3600`: how long the browser caches the preflight answer |

**Details to be aware of:**

- **API Gateway handles all of CORS.** That includes answering `OPTIONS`
  preflight requests *and* adding the headers to the real `GET` responses. The
  Go code sets no CORS headers (`api.go` only sets `Content-Type`). The name
  `cors_preflight` undersells this, because it configures both.
- **Origins must match exactly:** scheme, host and port. `http://localhost:5173`
  doesn't cover `http://127.0.0.1:5173` or another port.
- **A CORS failure doesn't show up as an API error.** The request reaches the
  API and succeeds, but the browser blocks the response and reports a CORS error
  in the dev-tools console. `curl` would show it working fine.
- **This is the second consumer of `FRONTEND_ORIGINS`**, after the bucket's CORS
  (Step 3b). Hence the Phase 6 reminder: add the CloudFront origin, or route
  `/api/*` through CloudFront so this API's CORS isn't needed at all.

### Q: What is CloudFront, and what's a "CloudFront origin"?

**CloudFront** is AWS's CDN (content delivery network): a worldwide set of
servers (*edge locations*) that sit in front of your content, cache it close to
users, and serve it over HTTPS. In Phase 6 it will host the frontend.
`npm run build` produces static files (`web/dist/`: HTML, JS, CSS), these get
uploaded to a private S3 bucket, and CloudFront serves them at a URL like
`https://d1abc2defghij.cloudfront.net`. That's what replaces the Vite dev server
outside of development.

**"Origin" means two different things,** and this tour has used both:

1. **Browser origin (the CORS sense):** the scheme + host + port a page was
   loaded from, e.g. `http://localhost:5173`. "Add the CloudFront origin to
   `FRONTEND_ORIGINS`" means this sense: once the site is served from
   `https://d1abc2defghij.cloudfront.net`, that string must be on the list so
   the API and the bucket accept requests from pages loaded there.
2. **CloudFront origin (CloudFront's own term):** a *backend* that CloudFront
   fetches from when it doesn't have something cached. A distribution can have
   several, chosen by path:
   - `/*` → the S3 bucket holding `web/dist/` (the site)
   - `/api/*` → API Gateway (the optional idea from earlier)

That second setup is why routing `/api/*` through CloudFront removes the need
for API CORS. The browser only ever talks to one browser origin (the CloudFront
URL), and CloudFront forwards API calls to its API Gateway origin behind the
scenes, so nothing is cross-origin any more. Presigned S3 URLs still point
directly at the docs bucket, so the bucket keeps its CORS rule.

### Q: Where are the CloudFront options specified in the CDK code?

**Nowhere yet.** There is no CloudFront in the CDK app today. The only
references are placeholders: the docstring at `web_stack.py:55` ("Frontend
hosting (S3 + CloudFront) joins this stack later") and the comment at
`app.py:15`.

According to `outline.md`, it's **Phase 6, step 22**, not Phase 5. Phase 5
builds the frontend against the Vite dev server. (Earlier parts of this tour
said "Phase 5" for CloudFront work. They have been corrected.) The plan is to
add it to `DocSearchWebStack`:

- a private S3 **site** bucket (separate from the docs bucket),
- a `cloudfront.Distribution` that reads from that bucket using **Origin Access
  Control** (CloudFront signs its own requests to the bucket, so the bucket
  stays fully private), with `index.html` as the default root object,
- `BucketDeployment` to upload `web/dist/` on each `cdk deploy`,
- the API URL handed to the build, either as `VITE_API_URL` or as a
  `config.json` that the deploy writes,
- the CloudFront URL added to `FRONTEND_ORIGINS`.

---

## Step 4i: The stage and throttling

`web_stack.py:119–142`

### What a stage is

An API's routes and integrations are its *definition*. A **stage** is a
*deployed, reachable* version of that definition, with its own URL and
settings. Some APIs have `dev` and `prod` stages, giving URLs like
`…/dev/manifest`.

- **`stage_name="$default"`** is a special name that means **no path prefix**:
  the URL is `https://<id>.execute-api…/manifest`, with no `/prod`. That's why
  `ApiUrl` ends in a bare `/`.
- **`auto_deploy=True`**: changes to routes go live immediately, with no
  separate "deploy the API" step.

**Why the stage is explicit** (`create_default_stage=False` on the `HttpApi`):
the stage that `HttpApi` creates automatically doesn't accept throttle settings,
so this code creates its own. A side effect is that the output uses `stage.url`.
`api.url` would be empty, because the API has no automatic stage.

### Throttling

```python
throttle=apigw.ThrottleSettings(rate_limit=20, burst_limit=50)
```

In the template: `DefaultRouteSettings: {ThrottlingRateLimit: 20, ThrottlingBurstLimit: 50}`.

It works like a bucket of 50 tokens that refills at 20 per second. Each request
uses one token.
- **Rate (20/s):** the sustained average the API allows.
- **Burst (50):** how many requests can arrive at once. The comment explains
  why: a markdown page with many images fires one `/file-url` call per image at
  the same moment.
- **When the bucket is empty,** API Gateway answers **429 Too Many Requests**
  itself. The Lambda isn't invoked, so a rejected request costs nothing.

**Details to be aware of:**

- **This is the API's only guard** (Step 4c: `AuthorizationType: NONE`). It
  doesn't keep anyone out. It **caps the bill**: even if someone hammers the
  URL, cost is limited to about 20 requests a second per route.
- **The frontend should expect an occasional 429** on very image-heavy pages and
  retry, or simply show the image as failed.
- These limits apply to **each route separately** (`DefaultRouteSettings`), so
  the two routes together can reach 40/s. AWS also has an account-wide limit
  (10,000/s by default) above everything.

### Q: For a personal tool, could these throttling numbers be tightened a lot, safely?

**The rate, yes. The burst, only partly.**

- **Rate (20/s → e.g. 5/s): safe to lower.** Normal use is a handful of requests
  per click, followed by seconds or minutes of reading. A sustained rate only
  matters if something is hammering the API.
- **Burst (50): it should stay at least as large as the image count of your most
  image-heavy markdown file.** Opening that file fires one `/file-url` per image
  at the same moment, so that's what "multiple requests per second from a single
  click" looks like. Something like 20–30 is probably still comfortable, as long
  as no doc has more images than that. Going below it would make some images
  fail with 429 errors unpredictably.
- **In development,** React's StrictMode runs effects twice, so each fetch may
  happen twice while using `npm run dev`. Keep that in mind before concluding
  that a low limit is broken.

**What tightening actually buys:** the limit only matters during abuse. A rough
worst case (sustained maximum, both routes, for a month) at today's 20/s is
on the order of **$100+ a month** in API Gateway and Lambda charges. At 5/s it
would be about a quarter of that. Lower is better, but neither number is a
real alarm.

**The more useful safeguard is an AWS Budgets alert,** e.g. "email me if this
month's bill exceeds $5." It catches abuse *and* any other surprise, such as a
logging mistake or forgotten resources, regardless of the throttle setting.

---

## Wrap-up

### Recap

```
                   DocSearchStack (storage, RETAIN)        DocSearchWebStack (read path, disposable)
Go CLI ──writes──►  S3 docs bucket   ◄──── grant_read ────  Lambda (Go, arm64, bootstrap)
                    DynamoDB table   ◄─ grant_read_data ──     ▲            │
                         │                                     │ invoke     └─► log group (30 days)
                     Exports ──────── Fn::ImportValue ────►  HTTP API ── $default stage (throttled)
                                                               ▲
Browser ── GET /manifest, /file-url ───────────────────────────┘
Browser ── presigned URL ──────────► S3 docs bucket (direct)
```

- **CDK compiles Python to CloudFormation.** Synth is offline, and deploy makes
  it real.
- **One stack is one template.** Storage is precious and the web stack is
  disposable. The one-way cross-stack link uses Exports and `Fn::ImportValue`.
- **Identity:** construct ID → logical ID → physical name. Keep the IDs of
  stateful resources stable, and run `cdk diff` to watch for "requires
  replacement".
- **L2s generate supporting resources:** the role, the policies and the invoke
  permissions. You grant what can't be inferred.
- **Assets:** source hash → bundle (local `go build`, with Docker as a
  fallback) → zip in the bootstrap bucket.

### Checklist for Phases 5–6

**Phase 5 (frontend against `npm run dev`):** no CDK changes are expected.
- `VITE_API_URL` in `web/.env.local` = the `ApiUrl` output.
- When something fails, a CORS error in the console means the origin isn't in
  `FRONTEND_ORIGINS`, and a 500 means it's time to check the Lambda's log group.
- Expect an occasional 429 on image-heavy pages, and remember StrictMode
  double-fetches in dev.

**Phase 6 (hosting):**
- Add the site bucket, a CloudFront distribution with Origin Access Control,
  and `BucketDeployment` to `DocSearchWebStack`.
- Add the CloudFront URL to `FRONTEND_ORIGINS`. Alternatively, route `/api/*`
  through CloudFront, in which case only the docs bucket's CORS still needs
  it.
- Optional while you're in there: lower the throttle rate, keeping the burst
  at or above the largest per-doc image count, and add an AWS Budgets alert.
- Update `cdk/CLAUDE.md`, which still says the env isn't pinned and describes
  only the storage stack (outline step 23).
- Run `cdk diff` before `cdk deploy`.

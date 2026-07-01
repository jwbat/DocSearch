
**Bedrock** is the AWS service — it's a managed gateway that gives you API access to a bunch of different foundation models without you having to host or manage any infrastructure yourself.  
It's the "front door": same API shape, IAM auth, billing, regardless of which model you're calling behind it.

**Titan** is Amazon's own family of models that happen to be available *through* Bedrock. Amazon trains and owns Titan; Bedrock is just one place you can call it from.

The reason this distinction matters: Bedrock also hosts models from other companies   
  — Anthropic's Claude, Cohere's Embed, Meta's Llama, and others — all behind that same Bedrock API.  

So when you call `bedrock-runtime.invoke_model()`, the `modelId` parameter is what tells Bedrock  
which underlying model to route to.  
In your case that's `amazon.titan-embed-text-v2:0` — the `amazon.` prefix signals it's a Titan model,  
as opposed to something like `cohere.embed-multilingual-v3` if you'd chosen Cohere's embedder instead.

architecture:  Bedrock is the AWS service/endpoint your Go Lambda talks to,
and Titan Embeddings V2 is the specific model you're asking Bedrock to run on your behalf.

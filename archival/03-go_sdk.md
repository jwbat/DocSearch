AWS SDK for Go v2 is the equivalent of boto3, and it's what one would actually use rather than hand-rolling HTTP calls.  
The package is github.com/aws/aws-sdk-go-v2, with a dedicated submodule for Bedrock:  
  `github.com/aws/aws-sdk-go-v2/service/bedrockruntime`.

It handles request signing (SigV4), retries, and credential resolution the same way boto3 does — you're not manually constructing HTTP requests or signing headers yourself.  
A minimal call looks like this:

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
)

type titanRequest struct {
	InputText  string `json:"inputText"`
	Dimensions int    `json:"dimensions"`
	Normalize  bool   `json:"normalize"`
}

type titanResponse struct {
	Embedding []float32 `json:"embedding"`
}

func embed(ctx context.Context, client *bedrockruntime.Client, text string) ([]float32, error) {
	body, err := json.Marshal(titanRequest{
		InputText:  text,
		Dimensions: 1024,
		Normalize:  true,
	})
	if err != nil {
		return nil, err
	}

	out, err := client.InvokeModel(ctx, &bedrockruntime.InvokeModelInput{
		ModelId:     aws.String("amazon.titan-embed-text-v2:0"),
		ContentType: aws.String("application/json"),
		Body:        body,
	})
	if err != nil {
		return nil, err
	}

	var resp titanResponse
	if err := json.Unmarshal(out.Body, &resp); err != nil {
		return nil, err
	}
	return resp.Embedding, nil
}

func main() {
	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-west-2"))
	if err != nil {
		panic(err)
	}
	client := bedrockruntime.NewFromConfig(cfg)

	vec, err := embed(ctx, client, "some markdown chunk text")
	if err != nil {
		panic(err)
	}
	fmt.Println(len(vec), vec[:5])
}
```

*config.LoadDefaultConfig* is the Go equivalent of boto3's default credential chain 
— it picks up IAM roles, env vars, ~/.aws/credentials, etc. in the same order boto3 does.  
Inside Lambda this resolves automatically from the execution role, no explicit credentials needed.  

The request/response bodies for InvokeModel are just raw JSON bytes ([]byte)   
— the SDK doesn't know or care about Titan's specific schema, so you marshal/unmarshal that yourself, as shown above.  
This is different from boto3's Bedrock client, which is similarly schema-agnostic at the invoke_model level too,  
so the pattern should feel familiar.
For your Lambda, you'd construct the bedrockruntime.Client once at package level (outside the handler) so it's reused across warm invocations — same idea as your package-level vector store cache.

Worth grabbing go get github.com/aws/aws-sdk-go-v2/service/bedrockruntime and go get github.com/aws/aws-sdk-go-v2/config when you get to this part.

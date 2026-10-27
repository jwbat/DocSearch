// Package api implements the read-only HTTP API behind API Gateway: listing
// the manifest and handing out short-lived presigned URLs for file content.
// It never writes to S3 or DynamoDB — the CLI is the only write path.
package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"docsearch-cli/internal/manifest"
)

// URLExpiry is how long a presigned file URL stays valid. The frontend asks
// for a fresh one each time a file is opened, so this only needs to cover
// the fetch itself.
const URLExpiry = 5 * time.Minute

// DB is the slice of the DynamoDB client the API needs.
type DB interface {
	dynamodb.ScanAPIClient
	manifest.GetItemAPI
}

// Presigner is the slice of s3.PresignClient the API needs.
type Presigner interface {
	PresignGetObject(ctx context.Context, params *s3.GetObjectInput, optFns ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
}

// Server holds the clients and resource names shared by every route.
type Server struct {
	DB        DB
	Presigner Presigner
	Table     string
	Bucket    string
}

// ManifestItem is one entry in the GET /manifest response.
type ManifestItem struct {
	Path         string `json:"path"`
	SHA256       string `json:"sha256"`
	SizeBytes    int64  `json:"size_bytes"`
	ContentType  string `json:"content_type"`
	ModifiedTime string `json:"modified_time"`
}

// FileURL is the GET /file-url response.
type FileURL struct {
	URL       string `json:"url"`
	ExpiresIn int    `json:"expires_in"`
}

// errorBody is the one error shape every route returns.
type errorBody struct {
	Error string `json:"error"`
}

// Handle routes an API Gateway HTTP API (payload v2) request to its handler.
func (s *Server) Handle(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	method := req.RequestContext.HTTP.Method
	switch {
	case method == http.MethodGet && req.RawPath == "/manifest":
		return s.manifest(ctx)
	case method == http.MethodGet && req.RawPath == "/file-url":
		return s.fileURL(ctx, req.RawQueryString)
	default:
		return errorResponse(http.StatusNotFound, "not found"), nil
	}
}

// manifest returns every live (not soft-deleted) entry, sorted by path.
func (s *Server) manifest(ctx context.Context) (events.APIGatewayV2HTTPResponse, error) {
	entries, err := manifest.Fetch(ctx, s.DB, s.Table)
	if err != nil {
		return internalError("scanning manifest", err), nil
	}

	items := make([]ManifestItem, 0, len(entries))
	for _, e := range entries {
		if e.Deleted {
			continue
		}
		items = append(items, ManifestItem{
			Path:         e.Path,
			SHA256:       e.SHA256,
			SizeBytes:    e.SizeBytes,
			ContentType:  e.ContentType,
			ModifiedTime: e.ModifiedTime,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Path < items[j].Path })

	return jsonResponse(http.StatusOK, items), nil
}

// fileURL presigns a GET for one file, but only if the manifest says it
// exists and isn't soft-deleted — the API must not presign arbitrary keys.
//
// The query string is parsed from RawQueryString rather than API Gateway's
// QueryStringParameters, which joins repeated keys with commas and would
// make a path containing a comma ambiguous.
func (s *Server) fileURL(ctx context.Context, rawQuery string) (events.APIGatewayV2HTTPResponse, error) {
	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return errorResponse(http.StatusBadRequest, "malformed query string"), nil
	}

	path := query.Get("path")
	if msg := validatePath(path); msg != "" {
		return errorResponse(http.StatusBadRequest, msg), nil
	}

	entry, found, err := manifest.Get(ctx, s.DB, s.Table, path)
	if err != nil {
		return internalError("looking up "+path, err), nil
	}
	if !found || entry.Deleted {
		return errorResponse(http.StatusNotFound, "file not found"), nil
	}

	input := &s3.GetObjectInput{
		Bucket: &s.Bucket,
		Key:    &entry.Path,
	}
	// Overriding the response Content-Type is what lets PDFs and images
	// render inline instead of downloading.
	if entry.ContentType != "" {
		input.ResponseContentType = &entry.ContentType
	}

	presigned, err := s.Presigner.PresignGetObject(ctx, input, s3.WithPresignExpires(URLExpiry))
	if err != nil {
		return internalError("presigning "+path, err), nil
	}

	return jsonResponse(http.StatusOK, FileURL{
		URL:       presigned.URL,
		ExpiresIn: int(URLExpiry.Seconds()),
	}), nil
}

// validatePath returns a client-facing reason the path is unacceptable, or
// "" if it's fine. Paths are manifest keys: relative, forward-slash
// separated, never escaping the root.
func validatePath(path string) string {
	if path == "" {
		return "missing path parameter"
	}
	if strings.HasPrefix(path, "/") {
		return "path must be relative"
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == ".." {
			return "path must not contain .."
		}
	}
	return ""
}

func jsonResponse(status int, body any) events.APIGatewayV2HTTPResponse {
	b, err := json.Marshal(body)
	if err != nil {
		return internalError("encoding response", err)
	}
	return events.APIGatewayV2HTTPResponse{
		StatusCode: status,
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       string(b),
	}
}

func errorResponse(status int, msg string) events.APIGatewayV2HTTPResponse {
	b, _ := json.Marshal(errorBody{Error: msg})
	return events.APIGatewayV2HTTPResponse{
		StatusCode: status,
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       string(b),
	}
}

// internalError logs the real cause (to CloudWatch, via the Lambda runtime)
// and returns a generic 500, so AWS error details never reach the client.
func internalError(what string, err error) events.APIGatewayV2HTTPResponse {
	log.Printf("%s: %v", what, err)
	return errorResponse(http.StatusInternalServerError, "internal error")
}

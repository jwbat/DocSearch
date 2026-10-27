package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"docsearch-cli/internal/manifest"
)

// fakeDB serves Scan in fixed-size pages (so pagination is exercised) and
// GetItem by path, from an in-memory set of entries.
type fakeDB struct {
	entries  map[string]manifest.Entry
	pageSize int
	scans    int
	err      error
}

func (f *fakeDB) Scan(_ context.Context, in *dynamodb.ScanInput, _ ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.scans++

	paths := make([]string, 0, len(f.entries))
	for p := range f.entries {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	start := 0
	if in.ExclusiveStartKey != nil {
		var k struct {
			Path string `dynamodbav:"path"`
		}
		if err := attributevalue.UnmarshalMap(in.ExclusiveStartKey, &k); err != nil {
			return nil, err
		}
		start = sort.SearchStrings(paths, k.Path) + 1
	}
	end := min(start+f.pageSize, len(paths))

	out := &dynamodb.ScanOutput{}
	for _, p := range paths[start:end] {
		item, err := attributevalue.MarshalMap(f.entries[p])
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, item)
	}
	if end < len(paths) {
		out.LastEvaluatedKey = map[string]types.AttributeValue{
			"path": &types.AttributeValueMemberS{Value: paths[end-1]},
		}
	}
	return out, nil
}

func (f *fakeDB) GetItem(_ context.Context, in *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	if f.err != nil {
		return nil, f.err
	}
	path := in.Key["path"].(*types.AttributeValueMemberS).Value
	e, ok := f.entries[path]
	if !ok {
		return &dynamodb.GetItemOutput{}, nil
	}
	item, err := attributevalue.MarshalMap(e)
	if err != nil {
		return nil, err
	}
	return &dynamodb.GetItemOutput{Item: item}, nil
}

// newServer wires a fake DB to the real presigner. Presigning only signs
// locally, so static fake credentials are enough and nothing hits AWS.
func newServer(db *fakeDB) *Server {
	client := s3.New(s3.Options{
		Region:      "us-west-2",
		Credentials: credentials.NewStaticCredentialsProvider("AKIDTEST", "SECRETTEST", ""),
	})
	return &Server{
		DB:        db,
		Presigner: s3.NewPresignClient(client),
		Table:     "manifest-table",
		Bucket:    "docs-bucket",
	}
}

func sampleEntries() map[string]manifest.Entry {
	return map[string]manifest.Entry{
		"b/report.pdf": {Path: "b/report.pdf", SHA256: "h1", SizeBytes: 10, ContentType: "application/pdf", ModifiedTime: "2026-10-01T00:00:00Z"},
		"a/notes.md":   {Path: "a/notes.md", SHA256: "h2", SizeBytes: 20, ContentType: "text/markdown; charset=utf-8", ModifiedTime: "2026-10-02T00:00:00Z"},
		"a/old.md":     {Path: "a/old.md", SHA256: "h3", Deleted: true, DeletedAt: "2026-10-03T00:00:00Z"},
		"c/photo.png":  {Path: "c/photo.png", SHA256: "h4", SizeBytes: 30, ContentType: "image/png", ModifiedTime: "2026-10-04T00:00:00Z"},
		"c/old.png":    {Path: "c/old.png", SHA256: "h5", Deleted: true},
	}
}

func get(path, rawQuery string) events.APIGatewayV2HTTPRequest {
	req := events.APIGatewayV2HTTPRequest{RawPath: path, RawQueryString: rawQuery}
	req.RequestContext.HTTP.Method = http.MethodGet
	return req
}

func errorMessage(t *testing.T, resp events.APIGatewayV2HTTPResponse) string {
	t.Helper()
	var body errorBody
	if err := json.Unmarshal([]byte(resp.Body), &body); err != nil {
		t.Fatalf("error body isn't JSON: %q", resp.Body)
	}
	return body.Error
}

func TestManifestFiltersDeletedAndPaginates(t *testing.T) {
	db := &fakeDB{entries: sampleEntries(), pageSize: 2}
	resp, err := newServer(db).Handle(context.Background(), get("/manifest", ""))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, body %s", resp.StatusCode, resp.Body)
	}
	if db.scans != 3 {
		t.Errorf("scan calls: got %d, want 3 (5 items, page size 2)", db.scans)
	}

	var items []ManifestItem
	if err := json.Unmarshal([]byte(resp.Body), &items); err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, it := range items {
		paths = append(paths, it.Path)
	}
	want := []string{"a/notes.md", "b/report.pdf", "c/photo.png"}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Errorf("paths: got %v, want %v (sorted, deleted filtered out)", paths, want)
	}
	if items[1].ContentType != "application/pdf" || items[1].SizeBytes != 10 || items[1].SHA256 != "h1" {
		t.Errorf("fields not carried through: %+v", items[1])
	}
}

func TestManifestEmptyIsArray(t *testing.T) {
	db := &fakeDB{entries: map[string]manifest.Entry{}, pageSize: 10}
	resp, _ := newServer(db).Handle(context.Background(), get("/manifest", ""))
	if resp.Body != "[]" {
		t.Errorf("body: got %q, want []", resp.Body)
	}
}

func TestFileURLPresigns(t *testing.T) {
	db := &fakeDB{entries: sampleEntries()}
	resp, err := newServer(db).Handle(context.Background(), get("/file-url", "path=b%2Freport.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, body %s", resp.StatusCode, resp.Body)
	}

	var body FileURL
	if err := json.Unmarshal([]byte(resp.Body), &body); err != nil {
		t.Fatal(err)
	}
	if body.ExpiresIn != 300 {
		t.Errorf("expires_in: got %d, want 300", body.ExpiresIn)
	}

	u, err := url.Parse(body.URL)
	if err != nil {
		t.Fatal(err)
	}
	if u.Host != "docs-bucket.s3.us-west-2.amazonaws.com" || u.Path != "/b/report.pdf" {
		t.Errorf("url target: got host %q path %q", u.Host, u.Path)
	}
	q := u.Query()
	if got := q.Get("X-Amz-Expires"); got != "300" {
		t.Errorf("X-Amz-Expires: got %q, want 300", got)
	}
	if got := q.Get("response-content-type"); got != "application/pdf" {
		t.Errorf("response-content-type: got %q, want application/pdf", got)
	}
	if q.Get("X-Amz-Signature") == "" {
		t.Error("url is not signed")
	}
}

func TestFileURLRejects(t *testing.T) {
	cases := []struct {
		name   string
		query  string
		status int
	}{
		{"missing path", "", http.StatusBadRequest},
		{"empty path", "path=", http.StatusBadRequest},
		{"leading slash", "path=%2Fa%2Fnotes.md", http.StatusBadRequest},
		{"dot-dot segment", "path=a%2F..%2Fsecret", http.StatusBadRequest},
		{"bad query", "path=%zz", http.StatusBadRequest},
		{"unknown path", "path=a%2Fnope.md", http.StatusNotFound},
		{"soft-deleted path", "path=a%2Fold.md", http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := &fakeDB{entries: sampleEntries()}
			resp, _ := newServer(db).Handle(context.Background(), get("/file-url", tc.query))
			if resp.StatusCode != tc.status {
				t.Errorf("status: got %d, want %d (body %s)", resp.StatusCode, tc.status, resp.Body)
			}
			if errorMessage(t, resp) == "" {
				t.Error("error body has no message")
			}
		})
	}
}

func TestFileURLAllowsDotsInNames(t *testing.T) {
	entries := map[string]manifest.Entry{
		"a/v1..2.md": {Path: "a/v1..2.md", ContentType: "text/markdown; charset=utf-8"},
	}
	resp, _ := newServer(&fakeDB{entries: entries}).Handle(context.Background(), get("/file-url", "path=a%2Fv1..2.md"))
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status: got %d, want 200 (only a whole .. segment is rejected)", resp.StatusCode)
	}
}

func TestUnknownRoute(t *testing.T) {
	db := &fakeDB{entries: sampleEntries()}
	srv := newServer(db)

	resp, _ := srv.Handle(context.Background(), get("/nope", ""))
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("unknown path: got %d, want 404", resp.StatusCode)
	}

	post := get("/manifest", "")
	post.RequestContext.HTTP.Method = http.MethodPost
	resp, _ = srv.Handle(context.Background(), post)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("POST /manifest: got %d, want 404", resp.StatusCode)
	}
}

func TestDBErrorIsGeneric500(t *testing.T) {
	db := &fakeDB{err: errors.New("AccessDeniedException: arn:aws:iam::123456789012:role/secret")}
	srv := newServer(db)

	for _, req := range []events.APIGatewayV2HTTPRequest{
		get("/manifest", ""),
		get("/file-url", "path=a%2Fnotes.md"),
	} {
		resp, _ := srv.Handle(context.Background(), req)
		if resp.StatusCode != http.StatusInternalServerError {
			t.Errorf("%s: got %d, want 500", req.RawPath, resp.StatusCode)
		}
		if strings.Contains(resp.Body, "arn:aws") {
			t.Errorf("%s: AWS error details leaked: %s", req.RawPath, resp.Body)
		}
	}
}

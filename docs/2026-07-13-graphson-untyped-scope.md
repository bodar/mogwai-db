# Future improvement: content-negotiated untyped GraphSON v4 responses

Status: **researched, not built** (2026-07-13). Recorded while landing the
OpenAPI/Scalar docs surface. The docs' gremlin `POST` currently returns a binary
GraphBinary body the Scalar "Test Request" panel can't render; this feature makes
non-binary clients (curl, the docs UI, any `fetch`) fully work.

## Goal

Let a generic HTTP/JSON client drive the same `/g/{id}` endpoint and get a
**readable JSON** result — without a TinkerPop GLV and without GraphBinary. Target
the **standard** format, not a homegrown one.

## Why untyped GraphSON v4 (not homegrown JSON, not JGF, not typed GraphSON)

TinkerPop 4's HTTP API defines three serializer mimes:
- `application/vnd.graphbinary-v4.0` — what we emit today
- `application/vnd.gremlin-v4.0+json;types=true` — GraphSON typed (`{"@type":"g:Int64","@value":2}`, verbose)
- `application/vnd.gremlin-v4.0+json;types=false` — GraphSON **untyped** ≈ natural JSON

Untyped GraphSON is a named standard AND human-readable — strictly better than
inventing a plain-JSON shape. JGF only represents graphs (nodes+edges), so it
can't encode the scalars/maps/paths most traversals return — wrong primary target.
Typed GraphSON is ugly and only needed for full type fidelity — a later add-on.

Note: the shipped v4 language drivers largely default to GraphBinary (gremlin-python
dropped GraphSON; the JS GLV is GraphBinary-only). So GraphSON here serves generic
HTTP clients, not out-of-the-box GLVs — but it's the correct standard for them.

## What's already done (halves the work)

`makeHandler` already sniffs the first request byte: non-`0x84` bodies are
`JSON.parse`d as `{gremlin, parameters/bindings, g}`. So JSON **requests** work
today. Only the **response** encoder is missing.

## Response envelope (v4 JSON)

```json
{ "result": { "data": [ /* one entry per traverser */ ] },
  "status": { "code": 200, "message": "", "exception": null } }
```

No `requestId` in the body (it's a `Gremlin-RequestId` response header, optional).
No bulk field (we emit unbulked). Mirrors our GraphBinary `frame()` 1:1. The JSON
path may also use real HTTP 4xx/5xx for errors (nicer than the always-200 trailer).

## Untyped GraphSON v4 shapes (from apache/tinkerpop master `io/graphson.asciidoc`)

| Thing | Untyped form |
|---|---|
| Vertex | `{"id":1,"label":["person"],"type":"vertex","properties":{"name":[{"id":0,"value":"marko"}]}}` |
| Edge | `{"id":13,"label":["knows"],"type":"edge","inV":{"id":10},"outV":{"id":1},"properties":{"weight":[0.5]}}` |
| VertexProperty (standalone) | `{"id":0,"value":"marko","label":["name"]}` |
| Property | `{"key":"since","value":2009}` |
| Map / valueMap / elementMap | plain object `{"name":["marko"],"id":1,...}` (complex keys → strings) |
| Path | `{"labels":[[],[]],"objects":[<vertex>,…]}` |
| List (fold) | plain array |
| Scalars | raw `2`, `"marko"`, `100.0`, `true`, `null` |

`label` is a singleton list — matches our GraphBinary v4 label handling.

## Implementation shape (~250–350 lines, ~½–1 day, LOW risk)

Every result `Shape` (`src/render.ts`, ~14 kinds + `GroupVal`/`GroupKey` sub-shapes
+ write vertex/edge) already has its row data computed by SQL; `execute()` in
`handler.ts` frames it to GraphBinary. Mirror it:

1. **Content negotiation** in `makeHandler` (~15 lines): sniff `Accept`.
   `application/vnd.graphbinary-v4.0` or absent → GraphBinary (today). `+json` /
   `application/json` → JSON path. GLVs always send the graphbinary mime AND
   validate the response Content-Type (connection.js throws on mismatch), so this
   is zero-risk for them.
2. **JSON envelope + error framing** (~15 lines).
3. **~8 leaf encoders** (vertex/edge/vprop/prop/map/path/list/scalar) (~100 lines).
4. **`executeJson()`** — the shape switch producing JS objects (~130 lines).
5. Contract cases over `Accept: application/json`.

**De-risking decision:** write `executeJson` SEPARATE and parallel to `execute` —
do NOT refactor a shared neutral value-tree, which would touch the locked,
contract-tested GraphBinary path. Some shape→structure duplication, zero risk to
the working wire.

Hardest shapes: `group` (mirror `groupBuffer`) and `path`/`pathGrouped` (mirror
`pathBuffer`). Both fiddly but bounded.

## Known deviations (would document, all pre-existing / consistent with GraphBinary)

- **Edge `inV`/`outV` = `{id}` only, no endpoint label.** Our edge row carries no
  endpoint labels (they ride empty in `edgeBuffer` too). The id VALUES are correct
  external ids (`COALESCE(uid,id)`, the W2 fix). No conformance test asserts the
  embedded endpoint label (verified: L3=582 green with edges in scope; the Gherkin
  harness compares edges by id, not embedded endpoint labels). "Carry endpoint
  labels" is a separate enhancement that would improve BOTH serializers.
- **Long/id > 2⁵³** → JS number precision loss (untyped GraphSON carries no type
  anyway; only bites huge counts/ids — could emit as string if needed).
- **Int vs Double** indistinguishable in untyped (spec limitation, not ours).

## Follow-on

Typed GraphSON (`types=true`): additive `@type/@value` envelopes on the same
encoders (~80 lines), only if a type-faithful consumer appears.

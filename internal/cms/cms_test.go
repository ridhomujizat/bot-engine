package cms

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/ridhomujizat/bot-engine/internal/model"
)

type fixedPick int

func (f fixedPick) IntN(n int) int { return int(f) % n }

func testBot(elements map[string]*model.ContentElement) *model.Bot {
	return &model.Bot{
		ID:              "b",
		Config:          model.BotConfig{DefaultLanguage: "en"},
		ContentElements: elements,
	}
}

func el(ct string, formData string) *model.ContentElement {
	var fd map[string]any
	if err := json.Unmarshal([]byte(formData), &fd); err != nil {
		panic(err)
	}
	return &model.ContentElement{ContentType: ct, FormData: fd}
}

func TestMustacheEscapesLikeMustacheJS(t *testing.T) {
	out, err := RenderTemplate("{{x}}", map[string]any{"x": `<a h="/">`})
	if err != nil {
		t.Fatal(err)
	}
	want := `&lt;a h&#x3D;&quot;&#x2F;&quot;&gt;`
	if out != want {
		t.Fatalf("got %q want %q", out, want)
	}
}

func TestMustacheRawAndMissing(t *testing.T) {
	ctx := map[string]any{"x": "<b>"}
	cases := map[string]string{
		"a{{nope}}b":   "ab",
		"{{&x}}":       "<b>",
		"{{{x}}}":      "<b>",
		"{{! note }}z": "z",
		"{{ x }}":      "&lt;b&gt;",
	}
	for tpl, want := range cases {
		got, err := RenderTemplate(tpl, ctx)
		if err != nil || got != want {
			t.Errorf("%q: got %q (%v) want %q", tpl, got, err, want)
		}
	}
}

func TestMustacheDottedLookup(t *testing.T) {
	ctx := map[string]any{"event": map[string]any{"payload": map[string]any{"text": "hi"}}}
	got, _ := RenderTemplate("{{event.payload.text}}", ctx)
	if got != "hi" {
		t.Fatalf("got %q", got)
	}
}

func TestRenderTemplateNestingLimit(t *testing.T) {
	ctx := map[string]any{"a": "{{b}}", "b": "{{c}}", "c": "{{d}}", "d": "X"}
	got, _ := RenderTemplate("{{a}}", ctx)
	// Three passes: a->b, b->c, c->d; the fourth pass does not run.
	if got != "{{d}}" {
		t.Fatalf("got %q want {{d}}", got)
	}
	got, _ = RenderTemplate("{{a}}", map[string]any{"a": "{{b}}", "b": "ok"})
	if got != "ok" {
		t.Fatalf("two-level got %q", got)
	}
}

func TestContainsTemplateQuirk(t *testing.T) {
	// "}}" without "{{" still triggers a render pass in output unchanged.
	got, err := RenderTemplate("a}}", nil)
	if err != nil || got != "a}}" {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestSectionsUnsupported(t *testing.T) {
	_, err := RenderTemplate("{{#x}}y{{/x}}", nil)
	if !errors.Is(err, ErrUnsupportedTag) {
		t.Fatalf("want ErrUnsupportedTag, got %v", err)
	}
}

func TestUnclosedTag(t *testing.T) {
	// "{{x" alone is not treated as a template (indexOf quirk), so it needs a "}}" after "{{".
	if _, err := RenderTemplate("{{ }} {{x", nil); !errors.Is(err, ErrTemplate) {
		t.Fatalf("want ErrTemplate, got %v", err)
	}
}

func TestRenderRecursiveNullBecomesEmptyObject(t *testing.T) {
	got, _ := RenderRecursive(map[string]any{"a": nil, "b": "{{x}}"}, map[string]any{"x": "1"})
	want := map[string]any{"a": map[string]any{}, "b": "1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v", got)
	}
}

func TestRenderTextLanguageAndFalsyDrop(t *testing.T) {
	bot := testBot(map[string]*model.ContentElement{
		"t1": el("builtin_text", `{"text$en":"Hi {{event.payload.text}}","typing$en":true,"markdown$en":false}`),
	})
	args := map[string]any{"event": map[string]any{"payload": map[string]any{"text": "X"}}}
	got, err := RenderElement(bot, "#!t1", args, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []map[string]any{{"type": "text", "text": "Hi X", "typing": true}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v", got)
	}
}

func TestRenderUserLanguageWins(t *testing.T) {
	bot := testBot(map[string]*model.ContentElement{
		"t1": el("builtin_text", `{"text$en":"Hi","text$id":"Halo"}`),
	})
	args := map[string]any{"event": map[string]any{"state": map[string]any{"user": map[string]any{"language": "id"}}}}
	got, _ := RenderElement(bot, "#!t1", args, nil)
	if got[0]["text"] != "Halo" {
		t.Fatalf("got %#v", got)
	}
	got, _ = RenderElement(bot, "#!t1", nil, nil)
	if got[0]["text"] != "Hi" {
		t.Fatalf("default lang fallback got %#v", got)
	}
}

func TestRenderVariationsPickAndText(t *testing.T) {
	bot := testBot(map[string]*model.ContentElement{
		"t1": el("builtin_text", `{"text$en":"first","variations$en":["second {{session.n}}"]}`),
	})
	args := map[string]any{"session": map[string]any{"n": "7"}}
	got, _ := RenderElement(bot, "#!t1", args, fixedPick(1))
	if got[0]["text"] != "second 7" {
		t.Fatalf("got %#v", got)
	}
	got, _ = RenderElement(bot, "#!t1", args, fixedPick(0))
	if got[0]["text"] != "first" {
		t.Fatalf("got %#v", got)
	}
}

func TestRenderSingleChoice(t *testing.T) {
	bot := testBot(map[string]*model.ContentElement{
		"c1": el("builtin_single-choice", `{"text$en":"Pick","choices$en":[{"title":"A","value":"a"}],"isDropdown$en":false}`),
	})
	got, err := RenderElement(bot, "#!c1", map[string]any{"temp": map[string]any{}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"type":    "single-choice",
		"text":    "Pick",
		"choices": []any{map[string]any{"title": "A", "value": "a"}},
	}
	if !reflect.DeepEqual(got[0], want) {
		t.Fatalf("got %#v", got[0])
	}
}

func TestRenderCardCarouselImageFile(t *testing.T) {
	bot := testBot(map[string]*model.ContentElement{
		"card": el("builtin_card", `{"title$en":"T","subtitle$en":"S","image$en":"http://i","markdown$en":true}`),
		"car":  el("builtin_carousel", `{"items$en":[{"title":"x"}]}`),
		"img":  el("builtin_image", `{"image$en":"http://img","title$en":"cap"}`),
		"file": el("builtin_file", `{"file$en":"http://f.pdf"}`),
	})
	cases := map[string]map[string]any{
		"#!card": {"type": "card", "title": "T", "subtitle": "S", "image": "http://i", "markdown": true},
		"#!car":  {"type": "carousel", "items": []any{map[string]any{"title": "x"}}},
		"#!img":  {"type": "image", "image": "http://img", "title": "cap"},
		"#!file": {"type": "file", "file": "http://f.pdf"},
	}
	for ref, want := range cases {
		got, err := RenderElement(bot, ref, nil, nil)
		if err != nil {
			t.Fatalf("%s: %v", ref, err)
		}
		if !reflect.DeepEqual(got[0], want) {
			t.Errorf("%s: got %#v want %#v", ref, got[0], want)
		}
	}
}

func TestRenderEventKeysStripped(t *testing.T) {
	bot := testBot(map[string]*model.ContentElement{"t1": el("builtin_text", `{"text$en":"x"}`)})
	args := map[string]any{"event": map[string]any{}, "temp": map[string]any{}, "user": map[string]any{}, "session": map[string]any{}, "bot": map[string]any{}}
	got, _ := RenderElement(bot, "#!t1", args, nil)
	if !reflect.DeepEqual(got[0], map[string]any{"type": "text", "text": "x"}) {
		t.Fatalf("got %#v", got[0])
	}
}

func TestRenderErrors(t *testing.T) {
	bot := testBot(map[string]*model.ContentElement{
		"dd": el("builtin_dropdown", `{"message$en":"x"}`),
	})
	if _, err := RenderElement(bot, "#!missing", nil, nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing: %v", err)
	}
	if _, err := RenderElement(bot, "#!dd", nil, nil); !errors.Is(err, ErrUnsupported) {
		t.Errorf("out-of-scope type: %v", err)
	}
	if _, err := RenderElement(bot, "@builtin_text", nil, nil); !errors.Is(err, ErrUnsupported) {
		t.Errorf("@type: %v", err)
	}
}

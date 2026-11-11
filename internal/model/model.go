// Package model holds the on-disk legacy bot formats (flows, content
// elements, bot config) as read by the engine. Shared by engine, flow loader,
// validator and studioapi. Field names and JSON tags follow legacy exactly.
//
// OWNERSHIP: shared contract. Add fields if needed; do not rename or remove.
package model

import (
	"encoding/json"
	"time"
)

// Bot is a fully loaded bot, as produced by flow.Load.
type Bot struct {
	ID              string
	Config          BotConfig
	Flows           map[string]*Flow           // key: flow name relative to flows/, e.g. "main.flow.json", "skills/choice-a1bdc2.flow.json"
	ContentElements map[string]*ContentElement // key: element id, e.g. "builtin_text-pSsHWg"
	Actions         map[string]string          // key: action name without .js, may contain "/" (e.g. "check-stock/search-product"); value: source
	Hooks           map[string][]Hook          // key: hook type, e.g. "before_conversation_end"; ordered by file name
	LoadedAt        time.Time
	ModifiedOn      time.Time // max modified_on of the bot's files at load time
}

type Hook struct {
	Name string // file path relative to hooks/{type}/, without .js
	Code string
}

// BotConfig is bot.config.json. Only fields the engine reads are typed; Raw keeps the full document.
type BotConfig struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Disabled        bool            `json:"disabled"`
	DefaultLanguage string          `json:"defaultLanguage"`
	Languages       []string        `json:"languages"`
	Dialog          *DialogConfig   `json:"dialog,omitempty"`
	Converse        *ConverseConfig `json:"converse,omitempty"`
	Raw             json.RawMessage `json:"-"`
}

type DialogConfig struct {
	TimeoutInterval        string `json:"timeoutInterval,omitempty"`        // e.g. "5m"
	SessionTimeoutInterval string `json:"sessionTimeoutInterval,omitempty"` // e.g. "30m"
}

type ConverseConfig struct {
	MaxMessageLength int `json:"maxMessageLength,omitempty"`
	Timeout          any `json:"timeout,omitempty"` // "5s" or number
}

// Flow is flows/*.json. Name is set by the loader (not stored in the file).
type Flow struct {
	Name        string          `json:"-"`
	Version     string          `json:"version,omitempty"`
	Label       string          `json:"label,omitempty"`
	Description string          `json:"description,omitempty"`
	Location    string          `json:"location,omitempty"`
	StartNode   string          `json:"startNode"`
	CatchAll    *NodeActions    `json:"catchAll,omitempty"`
	TimeoutNode string          `json:"timeoutNode,omitempty"`
	Type        string          `json:"type,omitempty"`
	SkillData   json.RawMessage `json:"skillData,omitempty"`
	Nodes       []*FlowNode     `json:"nodes"`
}

// NodeActions: onEnter/onReceive are lists of instruction strings
// ("say #!id {args}", "builtin/setVariable {json}", "myAction {json}").
// onReceive == nil (JSON null / absent) means the node does NOT wait for user input;
// an empty array means it waits. Keep that distinction (legacy semantics).
type NodeActions struct {
	OnEnter   []string          `json:"onEnter"`
	OnReceive *[]string         `json:"onReceive"`
	Next      []*NodeTransition `json:"next"`
}

type FlowNode struct {
	ID          string `json:"id,omitempty"`
	Name        string `json:"name"`
	Type        string `json:"type,omitempty"`  // "", "standard", "skill-call"
	Skill       string `json:"skill,omitempty"` // "choice" when Type == "skill-call"
	Flow        string `json:"flow,omitempty"`  // skill flow, e.g. "skills/choice-a1bdc2.flow.json"
	TimeoutNode string `json:"timeoutNode,omitempty"`
	NodeActions
}

type NodeTransition struct {
	Caption       string `json:"caption,omitempty"`
	Condition     string `json:"condition"`
	ConditionType string `json:"conditionType,omitempty"`
	Node          string `json:"node"` // node name | "#" | "#node" | "##" | "END" | "other.flow.json" | "other.flow.json#node" | ""
}

// FlowUI is flows/*.json (editor positions only; engine ignores it).
type FlowUI struct {
	Nodes []struct {
		ID       string          `json:"id"`
		Position json.RawMessage `json:"position"`
	} `json:"nodes"`
	Links []json.RawMessage `json:"links,omitempty"`
}

// ContentElement is one entry of content-elements/{contentType}.json (a JSON array).
// FormData keys carry a language suffix: "text$en", "choices$en", "typing$en",...
type ContentElement struct {
	ID          string         `json:"id"`
	ContentType string         `json:"-"` // set by loader from file name, e.g. "builtin_text"
	FormData    map[string]any `json:"formData"`
	CreatedBy   string         `json:"createdBy,omitempty"`
	CreatedOn   string         `json:"createdOn,omitempty"`
	ModifiedOn  string         `json:"modifiedOn,omitempty"`
}

/**
 * Keeps the mock webhook base URL for later actions. A builtin setVariable would run it through
 * Mustache, which HTML-escapes "/" and breaks the URL, so the copy is done in code.
 * @title Remember mock URL
 * @category E2E
 */
session.mock = event.payload.metadata.raw.mock

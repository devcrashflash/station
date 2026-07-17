import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import { remarkHideHtmlComments } from "./remarkHideHtmlComments.js";

function renderMarkdown(markdown) {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkHideHtmlComments] },
      markdown,
    ),
  );
}

test("hides single-line and inline HTML comments", () => {
  const rendered = renderMarkdown("Before <!-- hidden inline --> after\n\n<!-- hidden block -->");

  assert.equal(rendered, "<p>Before  after</p>");
});

test("hides multiline and multiple HTML comments", () => {
  const rendered = renderMarkdown(
    "Visible\n\n<!-- first\nmultiline comment -->\n\n<!-- second --><!-- third -->\n\nAfter",
  );

  assert.equal(rendered, "<p>Visible</p>\n<p>After</p>");
});

test("preserves comment syntax in inline and fenced code", () => {
  const rendered = renderMarkdown(
    "`<!-- inline code -->`\n\n```html\n<!-- fenced code -->\n```",
  );

  assert.match(rendered, /<code>&lt;!-- inline code --&gt;<\/code>/);
  assert.match(rendered, /<code class="language-html">&lt;!-- fenced code --&gt;\n<\/code>/);
});

test("continues escaping ordinary raw HTML", () => {
  const rendered = renderMarkdown("Before <span>raw HTML</span> after");

  assert.equal(rendered, "<p>Before &lt;span&gt;raw HTML&lt;/span&gt; after</p>");
});

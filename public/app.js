const form = document.querySelector("#translate-form");
const sourceInput = document.querySelector("#source-text");
const output = document.querySelector("#translation-output");
const translateButton = document.querySelector("#translate-button");
const buttonLabel = document.querySelector("#button-label");
const clearButton = document.querySelector("#clear-button");
const copyButton = document.querySelector("#copy-button");
const characterCount = document.querySelector("#character-count");
const outputCount = document.querySelector("#output-count");
const message = document.querySelector("#message");
let outputText = "";

function characterLabel(length) {
  return `${length.toLocaleString()} character${length === 1 ? "" : "s"}`;
}

function appendInlineMarkdown(parent, text) {
  const tokenPattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    const start = match.index;

    if (start > cursor) {
      parent.append(document.createTextNode(text.slice(cursor, start)));
    }

    const isBold = (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"));
    const element = document.createElement(isBold ? "strong" : "em");
    element.textContent = isBold ? token.slice(2, -2) : token.slice(1, -1);
    parent.append(element);
    cursor = start + token.length;
  }

  if (cursor < text.length) {
    parent.append(document.createTextNode(text.slice(cursor)));
  }
}

function renderMarkdown(target, markdown) {
  target.replaceChildren();
  if (!markdown) {
    return;
  }

  const blocks = markdown.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");

    if (lines.length > 0 && lines.every((line) => /^\s*[-+*]\s+/.test(line))) {
      const list = document.createElement("ul");
      for (const line of lines) {
        const item = document.createElement("li");
        appendInlineMarkdown(item, line.replace(/^\s*[-+*]\s+/, ""));
        list.append(item);
      }
      target.append(list);
      continue;
    }

    if (lines.length > 0 && lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
      const list = document.createElement("ol");
      for (const line of lines) {
        const item = document.createElement("li");
        appendInlineMarkdown(item, line.replace(/^\s*\d+[.)]\s+/, ""));
        list.append(item);
      }
      target.append(list);
      continue;
    }

    if (lines.length === 1 && /^\s*#{1,3}\s+/.test(lines[0])) {
      const level = lines[0].match(/^\s*(#{1,3})\s+/)[1].length;
      const heading = document.createElement(`h${level + 2}`);
      appendInlineMarkdown(heading, lines[0].replace(/^\s*#{1,3}\s+/, ""));
      target.append(heading);
      continue;
    }

    if (lines.length > 0 && lines.every((line) => /^\s*>\s?/.test(line))) {
      const quote = document.createElement("blockquote");
      for (const [index, line] of lines.entries()) {
        appendInlineMarkdown(quote, line.replace(/^\s*>\s?/, ""));
        if (index < lines.length - 1) {
          quote.append(document.createElement("br"));
        }
      }
      target.append(quote);
      continue;
    }

    if (lines.length === 1 && /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[0])) {
      target.append(document.createElement("hr"));
      continue;
    }

    const paragraph = document.createElement("p");
    for (const [index, line] of lines.entries()) {
      appendInlineMarkdown(paragraph, line);
      if (index < lines.length - 1) {
        paragraph.append(document.createElement("br"));
      }
    }
    target.append(paragraph);
  }
}

function extractClientSseEvent(buffer) {
  const boundary = /\r?\n\r?\n/.exec(buffer);
  if (!boundary) {
    return null;
  }
  return {
    content: buffer.slice(0, boundary.index),
    rest: buffer.slice(boundary.index + boundary[0].length),
  };
}

function handleClientSseEvent(event) {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data || data === "[DONE]") {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error("The server returned an invalid stream.");
  }

  if (payload.type === "error") {
    throw new Error(payload.error || "Generation failed.");
  }

  if (payload.type === "delta" && typeof payload.text === "string") {
    outputText += payload.text.replace(/\*/g, "");
    renderMarkdown(output, outputText);
    updateCounts();
  }
}

async function readClientStream(response) {
  if (!response.body) {
    throw new Error("The server did not return a stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const event = extractClientSseEvent(buffer);
        if (!event) {
          break;
        }
        handleClientSseEvent(event.content);
        buffer = event.rest;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      handleClientSseEvent(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

function updateCounts() {
  characterCount.textContent = characterLabel(sourceInput.value.length);
  outputCount.textContent = characterLabel(outputText.length);
  copyButton.disabled = outputText.length === 0;
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function setLoading(isLoading) {
  translateButton.disabled = isLoading;
  translateButton.classList.toggle("loading", isLoading);
  buttonLabel.textContent = isLoading ? "Generating" : "Generate post";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!form.reportValidity() || !sourceInput.value.trim()) {
    return;
  }

  setLoading(true);
  setMessage("Turning your English into a LinkedIn post…");
  outputText = "";
  renderMarkdown(output, outputText);
  updateCounts();

  try {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: sourceInput.value,
      }),
    });
    if (!response.ok) {
      let errorMessage = "Could not generate your post.";
      try {
        const result = await response.json();
        errorMessage = result.error || errorMessage;
      } catch {
        errorMessage = "The server returned an error.";
      }
      throw new Error(errorMessage);
    }

    await readClientStream(response);
    if (!outputText.trim()) {
      throw new Error("The server returned no text.");
    }
    setMessage("Your LinkedIn post is ready.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not generate your post.", true);
  } finally {
    setLoading(false);
    updateCounts();
  }
});

sourceInput.addEventListener("input", updateCounts);

sourceInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    form.requestSubmit();
  }
});

clearButton.addEventListener("click", () => {
  sourceInput.value = "";
  outputText = "";
  renderMarkdown(output, outputText);
  setMessage("Cleared.");
  updateCounts();
  sourceInput.focus();
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(outputText);
    setMessage("LinkedIn post copied.");
  } catch {
    const helper = document.createElement("textarea");
    helper.value = outputText;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    helper.remove();
    setMessage(copied ? "LinkedIn post copied." : "Copy failed; try again.", !copied);
  }
});

updateCounts();

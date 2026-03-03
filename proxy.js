import { ensureCopilotToken, state } from "./token-manager.js";

function buildHeaders(copilotToken) {
  return {
    Authorization: `Bearer ${copilotToken}`,
    "Content-Type": "application/json",
    "Editor-Version": "vscode/1.96.2",
    "User-Agent": "GitHubCopilotChat/0.26.7",
  };
}

// Returns { success: boolean } so caller can track stats accurately
async function proxyRequest(req, res) {
  const start = Date.now();
  const model = req.body?.model || "unknown";
  const isStream = req.body?.stream === true;

  try {
    const copilotToken = await ensureCopilotToken();
    const body = req.body;

    const targetUrl = `${state.apiBaseUrl}/chat/completions`;
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: buildHeaders(copilotToken),
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`❌ ${model} ${upstream.status} (${Date.now() - start}ms)${isStream ? " [stream]" : ""}`);
      res.status(upstream.status).json({
        error: {
          message: `Copilot API error: ${upstream.status}`,
          detail: errText,
        },
      });
      return { success: false };
    }

    if (isStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);
        }
      } catch (e) {
        // client disconnected or upstream error
        return { success: false };
      } finally {
        res.end();
      }
    } else {
      const json = await upstream.json();
      res.json(json);
    }
    console.log(`✅ ${model} 200 (${Date.now() - start}ms)${isStream ? " [stream]" : ""}`);
    return { success: true };
  } catch (err) {
    console.error(`❌ ${model} 502 (${Date.now() - start}ms): ${err.message}`);
    res.status(502).json({
      error: {
        message: err.message || "Proxy error",
      },
    });
    return { success: false };
  }
}

export { proxyRequest };

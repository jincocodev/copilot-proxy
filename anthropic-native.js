// 原生 Anthropic Messages passthrough 的請求整備
//
// Copilot 對所有 Claude 模型都開了原生 /v1/messages（見上游 GET /models 的
// supported_endpoints），所以 Claude 模型不需要經過 OpenAI 轉譯 —— 直接轉發就
// 拿得到 extended thinking、prompt caching 和精確 token 計數。
//
// 但上游跟官方 Anthropic API 有兩個差異，這裡負責敉平：
//
// 1. thinking 的形狀不同。官方是 {type:"enabled", budget_tokens:N}，
//    上游只吃 {type:"adaptive"} + output_config.effort，送 enabled 會拿到
//    400 "thinking.type.enabled is not supported for this model"。
//
// 2. 能力是逐模型的。sonnet-4.5 / opus-4.5 / haiku-4.5 沒有 reasoning_effort，
//    送 output_config.effort 會 400 "does not support reasoning effort"。

// effort 檔位由弱到強。上游各模型支援的子集不同（例如 opus-4.6 沒有 xhigh）。
const EFFORT_LADDER = ["none", "low", "medium", "high", "xhigh", "max"];

function supportsNativeMessages(modelInfo) {
  const endpoints = modelInfo?.supported_endpoints;
  return Array.isArray(endpoints) && endpoints.includes("/v1/messages");
}

function supportedEfforts(modelInfo) {
  const list = modelInfo?.capabilities?.supports?.reasoning_effort;
  return Array.isArray(list) ? list : null;
}

function supportsAdaptiveThinking(modelInfo) {
  return !!modelInfo?.capabilities?.supports?.adaptive_thinking;
}

// 把要求的檔位收斂到模型真的支援的那些之中，就近取用
function clampEffort(requested, allowed) {
  if (!allowed || allowed.length === 0) return null;
  if (allowed.includes(requested)) return requested;

  const want = EFFORT_LADDER.indexOf(requested);
  if (want < 0) return null;

  // 先往下找（寧可少想一點也不要 400），找不到再往上
  for (let i = want - 1; i >= 0; i--) {
    if (allowed.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i];
  }
  for (let i = want + 1; i < EFFORT_LADDER.length; i++) {
    if (allowed.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i];
  }
  return null;
}

// 官方的 budget_tokens 沒有直接對應，按佔上限的比例換成檔位
function budgetToEffort(budgetTokens, modelInfo) {
  const max = modelInfo?.capabilities?.supports?.max_thinking_budget || 32000;
  if (typeof budgetTokens !== "number" || budgetTokens <= 0) return "low";
  const ratio = budgetTokens / max;
  if (ratio >= 0.75) return "max";
  if (ratio >= 0.5) return "xhigh";
  if (ratio >= 0.25) return "high";
  if (ratio >= 0.1) return "medium";
  return "low";
}

// 回 { body, notes }。notes 是被改動或剝掉的東西，給 log 用。
function prepareNativeBody(original, resolvedModelId, modelInfo) {
  const body = { ...original, model: resolvedModelId };
  const notes = [];

  const efforts = supportedEfforts(modelInfo);
  const adaptive = supportsAdaptiveThinking(modelInfo);

  // client 直接給 output_config.effort（上游原生形狀）
  let wantedEffort = body.output_config?.effort ?? null;

  // client 給官方形狀的 thinking
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object") {
    if (thinking.type === "enabled") {
      // 上游不吃 enabled，換成 adaptive 並把 budget 折成檔位
      if (adaptive) {
        body.thinking = { type: "adaptive" };
        if (!wantedEffort) {
          wantedEffort = budgetToEffort(thinking.budget_tokens, modelInfo);
          notes.push(
            `thinking.enabled(budget=${thinking.budget_tokens}) → adaptive+effort=${wantedEffort}`
          );
        } else {
          notes.push("thinking.enabled → adaptive");
        }
      } else {
        delete body.thinking;
        notes.push(`${resolvedModelId} 不支援 thinking，已剝除`);
      }
    } else if (thinking.type === "adaptive" && !adaptive) {
      delete body.thinking;
      notes.push(`${resolvedModelId} 不支援 thinking，已剝除`);
    } else if (thinking.type === "disabled") {
      delete body.thinking;
    }
  }

  // 決定最終的 effort
  if (wantedEffort) {
    const clamped = clampEffort(wantedEffort, efforts);
    if (clamped) {
      body.output_config = { ...(body.output_config || {}), effort: clamped };
      if (clamped !== wantedEffort) {
        notes.push(`effort ${wantedEffort} → ${clamped}（${resolvedModelId} 只支援 ${efforts.join("/")}）`);
      }
      // effort 要生效必須同時有 adaptive thinking
      if (adaptive && !body.thinking) body.thinking = { type: "adaptive" };
    } else {
      // 這個模型完全不支援 effort，留著會 400
      if (body.output_config) {
        const { effort, ...rest } = body.output_config;
        if (Object.keys(rest).length > 0) body.output_config = rest;
        else delete body.output_config;
      }
      notes.push(`${resolvedModelId} 不支援 reasoning effort，已剝除 effort=${wantedEffort}`);
    }
  }

  return { body, notes };
}

// 上游回應裡的 Copilot 私有欄位，Anthropic 規格沒有，拿掉讓回應乾淨。
// 順手把成本抓出來給 log 用。
function stripCopilotFields(json) {
  if (!json || typeof json !== "object") return { json, costNanoAiu: null };
  if (!("copilot_usage" in json)) return { json, costNanoAiu: null };
  const { copilot_usage, ...rest } = json;
  return { json: rest, costNanoAiu: copilot_usage?.total_nano_aiu ?? null };
}

export {
  supportsNativeMessages,
  supportedEfforts,
  supportsAdaptiveThinking,
  clampEffort,
  budgetToEffort,
  prepareNativeBody,
  stripCopilotFields,
  EFFORT_LADDER,
};

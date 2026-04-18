const GITHUB_OWNER = "harunamitrader";
const GITHUB_REPO = "Hyperliquid-monitor";
const GITHUB_WORKFLOW = "update-data.yml";
const GITHUB_REF = "main";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function dispatchWorkflow(env) {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN secret");
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "hyperliquid-monitor-dispatcher",
      },
      body: JSON.stringify({
        ref: GITHUB_REF,
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${errorText}`);
  }

  return {
    ok: true,
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    workflow: GITHUB_WORKFLOW,
    ref: GITHUB_REF,
    dispatchedAt: new Date().toISOString(),
  };
}

export default {
  async fetch() {
    return jsonResponse({
      ok: true,
      message: "Worker is running. Scheduled events will dispatch GitHub Actions.",
      workflow: `${GITHUB_OWNER}/${GITHUB_REPO}:${GITHUB_WORKFLOW}`,
      ref: GITHUB_REF,
    });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      dispatchWorkflow(env).catch((error) => {
        console.error(error instanceof Error ? error.stack : String(error));
        throw error;
      }),
    );
  },
};

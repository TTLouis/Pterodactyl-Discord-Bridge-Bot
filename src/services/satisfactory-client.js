import http from "node:http";
import https from "node:https";

function normalizeApiUrl(value) {
  const url = new URL(value);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  url.pathname = !normalizedPath || normalizedPath === "/" ? "/api/v1" : normalizedPath;
  return url;
}

function parseJsonResponse(text, url, statusCode) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Satisfactory API at ${url} returned invalid JSON with status ${statusCode}: ${text}`);
  }
}

function requestJson(url, { headers, body, allowInsecureTls }) {
  const transport = url.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "POST",
        headers,
        rejectUnauthorized: url.protocol === "https:" ? !allowInsecureTls : undefined
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            body: text
          });
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function pickValue(data, keys, fallback = null) {
  for (const key of keys) {
    if (data?.[key] !== undefined) {
      return data[key];
    }
  }

  return fallback;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

export class SatisfactoryClient {
  async queryServerState(serverConfig) {
    const data = await this.#call(serverConfig, "QueryServerState");
    const serverGameState = pickValue(data, ["serverGameState", "ServerGameState"], {});

    return {
      activeSessionName: pickValue(serverGameState, ["activeSessionName", "ActiveSessionName"], ""),
      numConnectedPlayers: toNumberOrNull(pickValue(serverGameState, ["numConnectedPlayers", "NumConnectedPlayers"], 0)),
      playerLimit: toNumberOrNull(pickValue(serverGameState, ["playerLimit", "PlayerLimit"], serverConfig.maxPlayers)),
      isGameRunning: Boolean(pickValue(serverGameState, ["isGameRunning", "IsGameRunning"], false)),
      totalGameDuration: toNumberOrNull(pickValue(serverGameState, ["totalGameDuration", "TotalGameDuration"]))
    };
  }

  async runCommand(serverConfig, command) {
    const data = await this.#call(serverConfig, "RunCommand", {
      Command: command
    });
    const commandResult = String(pickValue(data, ["commandResult", "CommandResult"], ""));

    return {
      returnValue: Boolean(pickValue(data, ["returnValue", "ReturnValue"], false)),
      commandResult,
      outputLines: commandResult
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    };
  }

  async #call(serverConfig, functionName, data = {}) {
    const url = normalizeApiUrl(serverConfig.game.apiUrl);
    const body = JSON.stringify({
      function: functionName,
      data
    });
    const { statusCode, body: responseBody } = await requestJson(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${serverConfig.game.apiToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      body,
      allowInsecureTls: serverConfig.game.allowInsecureTls
    });

    const payload = parseJsonResponse(responseBody, url, statusCode);
    if (payload?.errorCode) {
      throw new Error(`Satisfactory API ${functionName} failed: ${payload.errorCode}${payload.errorMessage ? ` (${payload.errorMessage})` : ""}`);
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Satisfactory API ${functionName} failed with status ${statusCode}: ${responseBody || "(empty response)"}`);
    }

    return payload?.data ?? null;
  }
}

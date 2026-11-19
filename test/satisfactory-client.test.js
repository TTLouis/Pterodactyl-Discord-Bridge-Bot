import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { SatisfactoryClient } from "../src/services/satisfactory-client.js";

async function startApiServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function createServerConfig(apiUrl) {
  return {
    maxPlayers: 4,
    game: {
      apiUrl,
      apiToken: "test-token",
      allowInsecureTls: false,
      apiRequestTimeoutMs: 1000
    }
  };
}

test("Satisfactory errors omit response content and URL credentials", async () => {
  let status = 403;
  let body = "Bearer test-token";
  const api = await startApiServer((_request, response) => {
    response.writeHead(status).end(body);
  });

  try {
    const client = new SatisfactoryClient();
    const config = createServerConfig(`${api.apiUrl}/api/v1?key=private-query`);
    await assert.rejects(client.queryServerState(config), {
      message: "Satisfactory API QueryServerState failed with status 403"
    });

    status = 200;
    await assert.rejects(client.queryServerState(config), {
      message: "Satisfactory API QueryServerState returned invalid JSON with status 200"
    });

    body = JSON.stringify({ errorCode: "test-token", errorMessage: "Bearer test-token" });
    await assert.rejects(client.queryServerState(config), {
      message: "Satisfactory API QueryServerState reported an error with status 200"
    });
  } finally {
    await api.close();
  }
});

test("QueryServerState reads the official PascalCase response fields", async () => {
  const api = await startApiServer((request, response) => {
    assert.equal(request.url, "/api/v1");
    assert.equal(request.headers.authorization, "Bearer test-token");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      data: {
        ServerGameState: {
          ActiveSessionName: "Factory",
          NumConnectedPlayers: 3,
          PlayerLimit: 8,
          TechTier: 7,
          ActiveSchematic: "/Script/FactoryGame.FGSchematic'/Game/FactoryGame/Schematics/Schematic_Logistics_Mk2.Schematic_Logistics_Mk2'",
          GamePhase: "/Script/FactoryGame.FGGamePhase'/Game/FactoryGame/GamePhases/GP_Project_Assembly_Phase_0.GP_Project_Assembly_Phase_0'",
          IsGameRunning: true,
          TotalGameDuration: 42
        }
      }
    }));
  });

  try {
    const state = await new SatisfactoryClient().queryServerState(createServerConfig(api.apiUrl));
    assert.deepEqual(state, {
      activeSessionName: "Factory",
      numConnectedPlayers: 3,
      playerLimit: 8,
      techTier: 7,
      activeSchematic: "Logistics Mk2",
      gamePhase: "Project Assembly",
      isGameRunning: true,
      totalGameDuration: 42
    });
  } finally {
    await api.close();
  }
});

test("RunCommand succeeds when the official response omits ReturnValue", async () => {
  const api = await startApiServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      data: {
        CommandResult: "Command accepted\nSecond line"
      }
    }));
  });

  try {
    const result = await new SatisfactoryClient().runCommand(
      createServerConfig(api.apiUrl),
      "server.SomeCommand"
    );

    assert.equal(result.returnValue, true);
    assert.equal(result.command, "server.SomeCommand");
    assert.deepEqual(result.outputLines, ["Command accepted", "Second line"]);
  } finally {
    await api.close();
  }
});

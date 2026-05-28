import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import type { TerminalClient } from "./types";

export function createGatewayTerminalClient(api: GatewayWebSocketClientLike): TerminalClient {
  return {
    shellOptions() {
      return api.terminalShellOptions();
    },
    list(projectPathKey) {
      return api.listTerminals(projectPathKey);
    },
    create(params) {
      return api.createTerminal(params);
    },
    snapshot(sessionId, maxBytes, projectPathKey) {
      return api.snapshotTerminal(sessionId, maxBytes, projectPathKey);
    },
    async input(sessionId, data, projectPathKey) {
      await api.inputTerminal(sessionId, data, projectPathKey);
    },
    async resize(sessionId, cols, rows, projectPathKey) {
      await api.resizeTerminal(sessionId, cols, rows, projectPathKey);
    },
    rename(sessionId, title, projectPathKey) {
      return api.renameTerminal(sessionId, title, projectPathKey);
    },
    close(sessionId, projectPathKey) {
      return api.closeTerminal(sessionId, projectPathKey);
    },
    closeProject(projectPathKey) {
      return api.closeProjectTerminals(projectPathKey);
    },
    async detach(sessionId, projectPathKey) {
      await api.detachTerminal(sessionId, projectPathKey);
    },
    subscribe(listener) {
      return api.subscribeTerminal(listener);
    },
  };
}

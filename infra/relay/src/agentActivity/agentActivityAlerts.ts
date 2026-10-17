// Fork: the rules moved to `@t3tools/shared/agentActivityPush`, which the server's push gateway
// publisher shares with the relay.
export {
  type AgentActivityAlert,
  alertAllowedForPhase,
  alertForActivityRows,
  alertForAttentionTransition,
  alertForNewlyTerminal,
  alertForTerminalAggregate,
  attentionTransitionRows,
  isFreshTerminalNotification,
  newlyTerminalRows,
  shouldAlertForActivity,
  TERMINAL_NOTIFICATION_FRESHNESS_MS,
  terminalTransitionRows,
} from "@t3tools/shared/agentActivityPush";

export const scopedAgentId = (roomId: string | null | undefined, agentId: string) =>
  roomId ? `${roomId}:${agentId}` : agentId;

export const shortPath = (path: string | null | undefined) => {
  if (!path) return "No project path";
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-3).join("/")}`;
};

export const formatTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

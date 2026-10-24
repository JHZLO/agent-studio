export const agentAvatars = {
  role: { label: "Role default" },
  round: { label: "Round", color: "#5b41bd", background: "#dccfff", body: '<circle cx="50" cy="50" r="46"/>' },
  square: { label: "Square", color: "#216e68", background: "#bcebe6", body: '<rect x="6" y="6" width="88" height="88" rx="23"/>' },
  pebble: { label: "Pebble", color: "#5c6c37", background: "#dbe6c5", body: '<path d="M94 49c0 27-22 46-47 45C20 93 4 74 6 48 8 21 27 3 53 6c26 2 42 18 41 43Z"/>' },
  cat: { label: "Cat", color: "#99501e", background: "#ffd8b7", body: '<path d="M12 45 9 8q0-7 7-3l24 18q10-3 20 0L84 5q7-4 7 3l-3 37c8 35-9 49-38 49S4 80 12 45Z"/><path class="avatar-accent" d="m18 16 2 22 13-10Zm64 0-2 22-13-10Z"/><path class="avatar-detail" d="m46 70 4 3 4-3m-4 3v4m-24-9-11-2m11 9-11 2m59-9 11-2m-11 9 11 2"/>' },
  bunny: { label: "Bunny", color: "#a33164", background: "#ffd0e1", body: '<path d="M22 44C8-2 37-14 41 37q9-3 18 0C63-14 92-2 78 44c10 7 15 15 15 24 0 18-18 27-43 27S7 86 7 68c0-9 5-17 15-24Z"/><path class="avatar-detail" d="m29 14 5 21m37-21-5 21m-20 43q4 5 8 0"/>' },
  bear: { label: "Bear", color: "#81522d", background: "#e8c7a7", body: '<path d="M11 35C-6 16 18 1 32 19q18-9 36 0C82 1 106 16 89 35c8 10 10 21 7 33-4 18-20 27-46 27S8 86 4 68c-3-12-1-23 7-33Z"/><path class="avatar-accent" d="M16 28q-6-12 8-7Zm68 0q6-12-8-7Z"/><ellipse class="avatar-accent" cx="50" cy="73" rx="16" ry="12"/><path class="avatar-detail" d="m46 70 4 3 4-3m-4 3v5"/>' },
  robot: { label: "Robot", color: "#3b5f96", background: "#c4d6f6", body: '<path d="M50 14v15"/><circle cx="50" cy="10" r="6"/><rect x="2" y="46" width="10" height="23" rx="4"/><rect x="88" y="46" width="10" height="23" rx="4"/><rect x="10" y="28" width="80" height="64" rx="17"/><rect class="avatar-accent" x="21" y="43" width="58" height="29" rx="11"/><path class="avatar-detail" d="M41 81h18"/>' },
  ghost: { label: "Ghost", color: "#765493", background: "#e7def8", body: '<path d="M8 47C8-8 92-8 92 47v41q0 10-8 5l-12-8-15 9q-7 4-14 0l-15-9-12 8q-8 5-8-5Z"/><path class="avatar-detail" d="M44 66q6 6 12 0"/>' },
  star: { label: "Star", color: "#87600a", background: "#ffe59b", body: '<path d="m55 7 11 24 26 4q9 1 2 9L75 62l4 27q1 9-7 5L50 81 28 94q-8 4-7-5l4-27L6 44q-7-8 2-9l26-4L45 7q5-9 10 0Z"/>' },
  cloud: { label: "Cloud", color: "#2f6f91", background: "#c6e8fa", body: '<path d="M20 84C-4 84-5 49 17 45 8 19 42 10 52 29c15-24 46-5 35 16 22 7 16 39-7 39Z"/>' },
  sprout: { label: "Sprout", color: "#1b7451", background: "#c4efd9", body: '<path d="M50 44V26"/><path d="M50 28C29 32 18 20 20 6c19-1 30 7 30 22Zm0 5c-2-19 10-28 29-25 0 17-12 27-29 25Z"/><path d="M50 39c26 0 44 12 44 29 0 18-17 27-44 27S6 86 6 68c0-17 18-29 44-29Z"/>' },
  flower: { label: "Flower", color: "#a4434c", background: "#ffc8bc", body: '<path d="M35 20C30-5 70-5 65 20 84 4 108 35 84 44c29 7 14 42-9 31 4 30-38 30-37 2C16 98-7 64 17 51-10 39 14 5 35 20Z"/><circle class="avatar-accent" cx="50" cy="50" r="25"/>' },
};

const roleAvatars = { planner: "sprout", coder: "robot", reviewer: "cat", backend: "ghost", frontend: "star", documenter: "cloud" };

export function agentAvatar(agent) {
  return agent.avatar !== "role" && agentAvatars[agent.avatar]?.body ? agent.avatar : roleAvatars[agent.role] || "round";
}

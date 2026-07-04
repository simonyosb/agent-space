import React from "react";
import type { RoomRecord } from "../../types";

void React;

type Props = {
  rooms: RoomRecord[];
  activeRoomId: string | null;
  onSelectRoom: (id: string) => void;
  onNewRoom: () => void;
  onQuickOpen: () => void;
};

export function RoomTabs({
  rooms,
  activeRoomId,
  onSelectRoom,
  onNewRoom,
  onQuickOpen,
}: Props) {
  return (
    <nav className="room-tabs" aria-label="Rooms">
      <div className="room-tabs-home">
        <span className="brand-dot" aria-hidden="true" />
        <strong>AgentSpace</strong>
      </div>
      <div className="room-tab-strip">
        {rooms.map((room) => (
          <button
            className={`room-tab ${room.id === activeRoomId ? "is-active" : ""}`}
            key={room.id}
            onClick={() => onSelectRoom(room.id)}
            title={room.workspace.path}
            type="button"
          >
            <span>{room.workspace.name}</span>
            <small>{room.agents.length} agents</small>
          </button>
        ))}
        <button
          aria-label="New room"
          className="room-tab add-room-tab"
          onClick={onNewRoom}
          type="button"
          title="New room"
        >
          +
        </button>
      </div>
      <div className="room-tabs-context">
        <button className="quick-open-trigger" onClick={onQuickOpen} type="button">
          Quick open <kbd>Cmd+K</kbd>
        </button>
        <span>{rooms.length} rooms</span>
      </div>
    </nav>
  );
}

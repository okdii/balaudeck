import { useState } from "react";
import { SshPanel } from "./SshPanel";
import { DbPanel } from "./DbPanel";
import "./App.css";

type Tab = "ssh" | "db";

function App() {
  const [tab, setTab] = useState<Tab>("ssh");

  return (
    <main className="container">
      <h1>termdb · spike</h1>
      <div className="tabs">
        <button className={tab === "ssh" ? "active" : ""} onClick={() => setTab("ssh")}>
          SSH Terminal
        </button>
        <button className={tab === "db" ? "active" : ""} onClick={() => setTab("db")}>
          MySQL / MariaDB
        </button>
      </div>
      <div style={{ display: tab === "ssh" ? "block" : "none" }}>
        <SshPanel />
      </div>
      <div style={{ display: tab === "db" ? "block" : "none" }}>
        <DbPanel />
      </div>
    </main>
  );
}

export default App;

import { RefreshCw } from "lucide-react";

export default function ApplicationLoading() {
  return <main className="protected-route">
    <section aria-live="polite" className="protected-session" role="status">
      <div className="portal-panel">
        <div className="portal-panel-heading"><div><span className="portal-kicker">URMED</span><h1>Loading securely</h1><p>Please wait while the requested workspace is prepared.</p></div><RefreshCw aria-hidden="true" size={24} /></div>
      </div>
    </section>
  </main>;
}

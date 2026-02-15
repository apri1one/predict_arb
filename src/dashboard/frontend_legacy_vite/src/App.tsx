import { useState } from "react";
import { useSSE } from "./hooks/useSSE";
import { Header } from "./components/Header";
import { StatsPanel } from "./components/StatsPanel";
import { OpportunityList } from "./components/OpportunityList";
import { ClosePositionList } from "./components/ClosePositionList";

function App() {
  // In development, we might need full URL if not proxying.
  // But usually we set up proxy in vite.config.ts or use relative path if served by same backend.
  // For now let's assume relative path /api/stream works if served by backend,
  // or http://localhost:3001/api/stream if dev.
  const apiBase = import.meta.env.DEV ? 'http://localhost:3005' : '';
  const { opportunities, stats, connected } = useSSE(`${apiBase}/api/stream`);
  const [activeTab, setActiveTab] = useState<'arb' | 'close'>('arb');

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <Header stats={stats} connected={connected} />

      <main className="container mx-auto p-4 md:p-6 space-y-6">
        {/* Tab 导航 */}
        <div className="flex gap-2 border-b border-border pb-2">
          <button
            className={`px-4 py-2 text-sm font-medium rounded-t ${
              activeTab === 'arb'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('arb')}
          >
            Arbitrage
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium rounded-t ${
              activeTab === 'close'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('close')}
          >
            Position
          </button>
        </div>

        {/* Tab 内容 */}
        {activeTab === 'arb' ? (
          <>
            <StatsPanel stats={stats} />
            <OpportunityList opportunities={opportunities} />
          </>
        ) : (
          <ClosePositionList apiBase={apiBase} />
        )}
      </main>

      <footer className="border-t border-border mt-12 py-6 text-center text-xs text-muted-foreground">
        Bot Dashboard v1.0 • &copy; 2025 Predict Trading Bot
      </footer>
    </div>
  )
}

export default App

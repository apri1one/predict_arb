import type { SystemStats } from "../types";
import { Badge } from "./ui/badge";

interface HeaderProps {
    stats: SystemStats | null;
    connected: boolean;
}

export function Header({ stats, connected }: HeaderProps) {
    return (
        <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-50">
            <div className="container mx-auto py-4 px-4 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                    <h1 className="font-bold text-lg tracking-tight">ArbScanner <span className="text-primary">Pro</span></h1>
                </div>

                <div className="flex items-center gap-4 text-xs md:text-sm">
                    {stats && (
                        <div className="hidden md:flex gap-4 text-muted-foreground">
                            <span className="flex items-center gap-1">
                                PM: <span className={stats.connectionStatus.polymarketWs === 'connected' ? "text-green-500" : "text-red-500"}>
                                    {stats.latency.polymarket}ms
                                </span>
                            </span>
                            <span className="flex items-center gap-1">
                                Predict: <span className={stats.connectionStatus.predictApi === 'ok' ? "text-green-500" : "text-yellow-500"}>
                                    {stats.latency.predict}ms
                                </span>
                            </span>
                        </div>
                    )}
                    <Badge variant={connected ? "outline" : "destructive"} className="text-xs">
                        {connected ? "LIVE" : "DISCONNECTED"}
                    </Badge>
                </div>
            </div>
        </header>
    );
}

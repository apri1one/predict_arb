import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import type { SystemStats } from "../types";
import { Activity, DollarSign, TrendingUp, Zap } from "lucide-react";

interface StatsPanelProps {
    stats: SystemStats | null;
}

export function StatsPanel({ stats }: StatsPanelProps) {
    if (!stats) return <div className="animate-pulse h-32 bg-secondary rounded-lg"></div>;

    const { arbStats } = stats;

    return (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Active Opportunities</CardTitle>
                    <Activity className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{arbStats.makerCount + arbStats.takerCount}</div>
                    <p className="text-xs text-muted-foreground">
                        {arbStats.makerCount} Maker / {arbStats.takerCount} Taker
                    </p>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Avg Profit</CardTitle>
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{arbStats.avgProfit}%</div>
                    <p className="text-xs text-muted-foreground">
                        Max: {arbStats.maxProfit}%
                    </p>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Market Depth</CardTitle>
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">${arbStats.totalDepth}</div>
                    <p className="text-xs text-muted-foreground">
                        Total Liquidity
                    </p>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Markets Monitored</CardTitle>
                    <Zap className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{stats.marketsMonitored}</div>
                    <p className="text-xs text-muted-foreground">
                        Refresh: {stats.refreshInterval}ms
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}

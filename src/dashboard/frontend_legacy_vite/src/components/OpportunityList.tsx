import type { ArbOpportunity } from "../types";
import { OpportunityCard } from "./OpportunityCard";

interface OpportunityListProps {
    opportunities: ArbOpportunity[];
}

export function OpportunityList({ opportunities }: OpportunityListProps) {
    if (opportunities.length === 0) {
        return (
            <div className="text-center py-12 text-muted-foreground border-2 border-dashed border-secondary rounded-lg">
                No active arbitrage opportunities found.
                <br />
                <span className="text-sm">Scanning markets...</span>
            </div>
        );
    }

    // Sort by profit percent descending
    const sorted = [...opportunities].sort((a, b) => b.profitPercent - a.profitPercent);

    return (
        <div className="space-y-4">
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
                Live Opportunities
                <span className="text-sm font-normal text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                    {opportunities.length}
                </span>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {sorted.map((opp) => (
                    <OpportunityCard key={opp.marketId} opp={opp} />
                ))}
            </div>
        </div>
    );
}

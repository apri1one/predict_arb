import type { ArbOpportunity } from "../types";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";

interface OpportunityCardProps {
    opp: ArbOpportunity;
}

export function OpportunityCard({ opp }: OpportunityCardProps) {
    const [expanded, setExpanded] = useState(false);

    const predictHref = (() => {
        const slug = opp.predictSlug || opp.title
            .toLowerCase()
            .replace(/@/g, 'at')
            .replace(/[^a-z0-9 -]/g, '')
            .replace(/ +/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        return `https://predict.fun/market/${slug}`;
    })();

    const polymarketHref = opp.polymarketSlug
        ? `https://polymarket.com/event/${opp.polymarketSlug}`
        : `https://polymarket.com/markets?_q=${encodeURIComponent(opp.title.substring(0, 50))}`;

    const iconClassName = "w-4 h-4 block";

    return (
        <Card className="border-l-4 border-l-primary/50 overflow-hidden hover:bg-secondary/10 transition-colors">
            <div className="p-4" onClick={() => setExpanded(!expanded)}>
                <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                        <Badge variant={opp.strategy === 'MAKER' ? 'success' : 'secondary'} className={opp.strategy === 'MAKER' ? 'bg-green-600' : 'bg-blue-600'}>
                            {opp.strategy}
                        </Badge>
                        <h3 className="font-semibold text-sm md:text-base line-clamp-1" title={opp.title}>
                            {opp.title}
                        </h3>
                        {/* View on Platform Buttons */}
                        <div className="flex items-center gap-1 ml-1">
                            <a
                                href={predictHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="p-1 rounded hover:bg-secondary/50 transition-colors"
                                title="View on Predict"
                            >
                                <img src="/predict.png" className={iconClassName} alt="Predict" />
                            </a>
                            <a
                                href={polymarketHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="p-1 rounded hover:bg-secondary/50 transition-colors"
                                title={opp.polymarketSlug ? "View on Polymarket" : "Search on Polymarket"}
                            >
                                <img src="/polymarket.ico" className={iconClassName} alt="Polymarket" />
                            </a>
                        </div>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className="text-xl font-bold text-green-400">{opp.profitPercent}%</span>
                        <span className="text-xs text-muted-foreground">Profit</span>
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-sm mb-3">
                    <div className="bg-secondary/30 p-2 rounded">
                        <span className="text-xs text-muted-foreground block">Predict</span>
                        <span className="font-mono font-medium">{opp.predictPrice}¢</span>
                    </div>
                    <div className="bg-secondary/30 p-2 rounded">
                        <span className="text-xs text-muted-foreground block">Polymarket</span>
                        <span className="font-mono font-medium">{opp.polymarketPrice}¢</span>
                    </div>
                    <div className="bg-secondary/30 p-2 rounded">
                        <span className="text-xs text-muted-foreground block">Est. Return</span>
                        <span className="font-mono font-medium text-green-400">${opp.estimatedProfit}</span>
                    </div>
                </div>

                <div className="flex justify-between items-center text-xs text-muted-foreground">
                    <span>Qty: {opp.maxQuantity}</span>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                        <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
                    </Button>
                </div>
            </div>

            {expanded && (
                <CardContent className="bg-secondary/20 pt-4 border-t border-border">
                    <div className="space-y-3 text-sm">
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <span className="text-muted-foreground block">Strategy Details</span>
                                <p>Buy YES on Predict @ {opp.predictPrice}¢</p>
                                <p>Sell YES (or Buy NO) on PM @ {opp.polymarketPrice}¢</p>
                            </div>
                            <div>
                                <span className="text-muted-foreground block">Cost & Depth</span>
                                <p>Total Cost: ${opp.totalCost}</p>
                                <p>Depth: Predict {opp.depth.predict} / PM {opp.depth.polymarket}</p>
                            </div>
                        </div>

                        <div className="flex justify-end gap-2 mt-4">
                            <Button size="sm" variant="outline" className="opacity-75" disabled>
                                Simulate
                            </Button>
                            <Button size="sm" className="bg-primary hover:bg-primary/90" disabled>
                                Execute Trade <ExternalLink className="ml-2 h-3 w-3" />
                            </Button>
                        </div>
                        <p className="text-[10px] text-muted-foreground text-center pt-2">
                            Trade execution coming in v2.0
                        </p>
                    </div>
                </CardContent>
            )}
        </Card>
    );
}

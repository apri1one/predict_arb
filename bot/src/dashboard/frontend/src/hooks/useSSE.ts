import { useEffect, useState, useRef } from 'react';
import type { ArbOpportunity, SystemStats } from '../types';

interface SSEState {
    opportunities: ArbOpportunity[];
    stats: SystemStats | null;
    connected: boolean;
}

interface OpportunityBatch {
    items: ArbOpportunity[];
    offset: number;
    total: number;
    done: boolean;
}

function withAuthToken(url: string): string {
    if (typeof window === 'undefined') return url;
    const token = localStorage.getItem('dashboardApiToken') || localStorage.getItem('DASHBOARD_API_TOKEN');
    if (!token) return url;
    const urlObj = new URL(url, window.location.origin);
    urlObj.searchParams.set('token', token);
    return urlObj.toString();
}

export function useSSE(url: string) {
    const [data, setData] = useState<SSEState>({
        opportunities: [],
        stats: null,
        connected: false
    });

    // 用于累积分片数据的 ref（不触发重渲染）
    const batchAccumulator = useRef<ArbOpportunity[]>([]);

    useEffect(() => {
        const eventSource = new EventSource(withAuthToken(url));

        // 分片接收：累积合并后更新（用于初始快照和补偿同步）
        eventSource.addEventListener('opportunity-batch', (e) => {
            try {
                const batch: OpportunityBatch = JSON.parse(e.data);

                // offset=0 时重置累积器（新一轮分片开始）
                if (batch.offset === 0) {
                    batchAccumulator.current = [];
                }

                // 累积当前批次
                batchAccumulator.current.push(...batch.items);

                // done=true 时更新状态
                if (batch.done) {
                    const opportunities = batchAccumulator.current;
                    batchAccumulator.current = [];
                    setData(prev => ({ ...prev, opportunities }));
                }
            } catch (err) {
                console.error('Failed to parse opportunity-batch data', err);
            }
        });

        // 完整更新：直接替换（用于广播）
        eventSource.addEventListener('opportunity', (e) => {
            try {
                const opportunities = JSON.parse(e.data);
                setData(prev => ({ ...prev, opportunities }));
            } catch (err) {
                console.error('Failed to parse opportunity data', err);
            }
        });

        eventSource.addEventListener('stats', (e) => {
            try {
                const stats = JSON.parse(e.data);
                setData(prev => ({ ...prev, stats }));
            } catch (err) {
                console.error('Failed to parse stats data', err);
            }
        });

        eventSource.onopen = () => setData(prev => ({ ...prev, connected: true }));
        eventSource.onerror = () => setData(prev => ({ ...prev, connected: false }));

        return () => {
            eventSource.close();
        };
    }, [url]);

    return data;
}

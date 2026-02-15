import Database from 'better-sqlite3';
const db = new Database('./data/task-logs.db');

const taskId = 'BUY-691-1767679037564';
const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp ASC').all(taskId) as any[];

console.log('=== Task Events for', taskId, '===\n');

events.forEach((e: any) => {
    const data = JSON.parse(e.data || '{}');
    console.log(`[${new Date(e.timestamp).toLocaleTimeString()}] ${e.event_type}`);

    // 显示关键字段
    const keys = ['error', 'reason', 'platform', 'side', 'price', 'quantity', 'filledQty',
                  'hedgeQty', 'totalHedged', 'retryCount', 'avgPrice', 'remainingQty'];
    keys.forEach(k => {
        if (data[k] !== undefined && data[k] !== null && data[k] !== '') {
            console.log(`  ${k}: ${data[k]}`);
        }
    });

    // 如果有 orderId，截短显示
    if (data.orderId) {
        console.log(`  orderId: ${data.orderId.slice(0, 30)}...`);
    }

    console.log();
});

db.close();

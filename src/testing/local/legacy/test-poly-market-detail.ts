async function main() {
    const conditionId = '0x9ae0f0d0f91a9491980c302502dc763626ec140a620a3a8018107a42fcdf5318';

    console.log('=== Polymarket Gamma API ===\n');
    const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
    const data = await res.json();

    if (data && data.length > 0) {
        const market = data[0];
        console.log('Question:', market.question);
        console.log('End Date:', market.endDate);
        console.log('Closed:', market.closed);
        console.log('Active:', market.active);
    } else {
        console.log('未找到市场');
    }
}

main().catch(console.error);

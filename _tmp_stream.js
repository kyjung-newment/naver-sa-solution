const path=require('path');
const dbPath=path.resolve('./src/db/database.js');
const apiPath=path.resolve('./src/api/naverApi.js');
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{
  queryStatsSummary:async()=>({impCnt:0,clkCnt:0,salesAmt:0,purchaseCnt:0,purchaseAmt:0,roas:0,ctr:0,cpc:0,avgRnk:0}),
  queryStatsKeywords:async()=>[], queryStatsCampaigns:async()=>[], queryStatsAdgroups:async()=>[],
  queryStatsDevice:async()=>[], queryStatsHourly:async()=>({byHour:[],byDay:[]}), queryStatsTrend:async()=>[],
  buildKeywordMaps:async()=>({campMap:{c1:{name:'캠A',tp:1}},agMap:{a1:{name:'그룹A'}},kwMap:{k1:{keyword:'좋은키워드',qi:7}}}),
  getMasterKeywords:async()=>[{keyword:'좋은키워드'}], parseReportConfig:()=>({sheets:{},customSheets:[]}),
}};
require.cache[apiPath]={id:apiPath,filename:apiPath,loaded:true,exports:{ createApiClient:()=>({
  createAndDownloadStatReport: async(tp,dt)=>{
    // each day: keyword k1: imp100 clk10 cost20000 rank3, conv 2 purchases 120000
    if(tp==='AD_DETAIL') return [['x','cust','c1','a1','k1','ad','biz','14','0','q','P','100','10','20000','3.0']];
    if(tp==='AD_CONVERSION_DETAIL') return [['x','cust','c1','a1','k1','ad','ch','14','0','q','P','0','구매완료','2','120000']];
    return [];
  },
  getStats: async()=>null, // skip override to see raw aggregation
  getRelatedKeywords: async()=>[],
})}};
const gen=require('./src/report/generator.js');
(async()=>{
  // 10-day range. Expected: k1 cost=20000*10=200000, clk=100, purchaseCnt=20, purchaseAmt=1200000
  // Monkey-patch rollingRange? It's internal. Use 'weekly' (7d) and 'monthly'(30d). Let me check 'weekly' produces 7 days.
  const acct={id:1,name:'T',api_key:'x',secret_key:'y',customer_id:'z'};
  const up=await gen.runStrategy(acct,'weekly','upsell',{track:'hold_roas',channels:['powerlink','shopping']});
  console.log('WEEKLY(7d) period:',up.period);
  // total should reflect 7 days. Check via a downsell or the groups
  const brief=await gen.generateAnalysisBrief(acct,'weekly');
  console.log('WEEKLY kpi (7d, no getStats override):',JSON.stringify(brief.kpi));
  console.log('  expected cost=20000*7=140000, clk=10*7=70, purchaseAmt=120000*7=840000');
  const briefM=await gen.generateAnalysisBrief(acct,'monthly');
  console.log('MONTHLY kpi (30d streaming):',JSON.stringify(briefM.kpi));
  console.log('  expected cost=20000*30=600000, clk=300, purchaseAmt=3600000');
})().catch(e=>{console.error('ERR',e);process.exit(1);});

const path=require('path');
const dbPath=path.resolve('./src/db/database.js');
const apiPath=path.resolve('./src/api/naverApi.js');
// Stub db: empty stats (forces live), but master maps present
const dbStub={
  queryStatsSummary:async()=>({impCnt:0,clkCnt:0,salesAmt:0,purchaseCnt:0,purchaseAmt:0,roas:0,ctr:0,cpc:0,avgRnk:0}),
  queryStatsKeywords:async()=>[], queryStatsCampaigns:async()=>[], queryStatsAdgroups:async()=>[],
  queryStatsDevice:async()=>[], queryStatsHourly:async()=>({byHour:[],byDay:[]}), queryStatsTrend:async()=>[],
  buildKeywordMaps:async()=>({campMap:{c1:{name:'캠A',tp:1}},agMap:{a1:{name:'그룹A'}},kwMap:{k1:{keyword:'좋은키워드',qi:7}}}),
  getMasterKeywords:async()=>[{keyword:'좋은키워드'}],
  parseReportConfig:()=>({sheets:{},customSheets:[]}),
};
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:dbStub};
// Stub naverApi
const apiStub={ createApiClient:()=>({
  createAndDownloadStatReport: async(tp,dt)=>{
    if(tp==='AD_DETAIL') return [['20260601','cust','c1','a1','k1','ad1','biz','14','0','q','P','100','10','20000','3.0']];
    if(tp==='AD_CONVERSION_DETAIL') return [['20260601','cust','c1','a1','k1','ad1','ch','14','0','q','P','0','구매완료','2','120000']];
    return [];
  },
  getStats: async()=>({impCnt:3000,clkCnt:300,salesAmt:600000,purchaseCcnt:60,purchaseConvAmt:3600000}),
  getRelatedKeywords: async()=>[],
})};
require.cache[apiPath]={id:apiPath,filename:apiPath,loaded:true,exports:apiStub};

const gen=require('./src/report/generator.js');
(async()=>{
  const acct={id:1,name:'T',api_key:'x',secret_key:'y',customer_id:'z'};
  const up=await gen.runStrategy(acct,'monthly','upsell',{track:'hold_roas'});
  console.log('period:',up.period);
  console.log('total via getStats? upsell items:',up.items.length,'| first:',up.items[0]?up.items[0].name+' roas='+up.items[0].roas:'none');
  const brief=await gen.generateAnalysisBrief(acct,'weekly');
  console.log('brief kpi:',JSON.stringify(brief.kpi));
})().catch(e=>{console.error('ERR',e);process.exit(1);});

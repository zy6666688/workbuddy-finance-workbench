// A starting checklist, never an exhaustive disclosure determination.
const topics:Record<string,string[]>={
 small_2011:['遵循小企业会计准则的声明','短期投资、应收账款、存货及固定资产说明','应付职工薪酬及应交税费说明','利润分配说明','担保资产、未决诉讼仲裁及对外担保','严重亏损时持续经营计划','企业所得税纳税调整过程','其他需说明事项'],
 enterprise_2019_new:['财务报表编制基础','遵循企业会计准则的声明','重要会计政策和会计估计','会计政策、估计变更及差错更正','报表重要项目说明','其他重要事项']
};
export function disclosureTopics(basis:string|null){return basis?topics[basis]||[]:[]}
export function disclosureReview(input:any){
 const expected=disclosureTopics(input.reportingBasis),entries=input.disclosureReview||[],issues:{type:string;reference:string;message:string}[]=[],seen=new Map<string,any>();
 for(const row of entries){
  if(!expected.includes(row.topic)){issues.push({type:'disclosure',reference:row.topic,message:'该主题不属于当前准则的附注核对清单'});continue}
  if(seen.has(row.topic)){issues.push({type:'disclosure',reference:row.topic,message:'附注核对主题重复'});continue}
  if(row.status!=='pending'&&(!row.content||!row.evidence))issues.push({type:'disclosure',reference:row.topic,message:'已填写或不适用均需说明和依据'});
  seen.set(row.topic,row);
 }
 const rows=expected.map(topic=>seen.get(topic)||{topic,status:'pending',content:'',evidence:''});
 const pending=rows.filter(row=>row.status==='pending').length;
 return {status:expected.length?'附注核对清单，需独立复核':'未选择准则',rows,pending,issues,
  limitations:'此清单仅为提示，并非全部披露要求；适用性、披露内容和完整性须由会计判断。'};
}

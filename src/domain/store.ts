import { Asset, DomainEvent, Incident, TelemetrySample, TopologyVersion, WorkOrder } from './types';
export class TwinStore {
  assets = new Map<string,Asset>(); telemetry:TelemetrySample[]=[]; events:DomainEvent[]=[]; incidents=new Map<string,Incident>(); workOrders=new Map<string,WorkOrder>(); topology:TopologyVersion[]=[];
  // 幂等注册表：业务事件 ID -> 已接受的最终事实（事件 + 样本），顺序/并发重试都以此为准
  facts=new Map<string,{event:DomainEvent;sample:TelemetrySample}>();
}

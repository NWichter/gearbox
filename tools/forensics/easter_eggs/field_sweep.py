import collections, json, subprocess, sys
f=sys.argv[1]; out=sys.argv[2]
F=["wlan.fc.type_subtype","wlan.ta","wlan.ra","wlan.ssid","wlan.fixed.beacon","wlan.fixed.capabilities","wlan.fixed.listen_ival","wlan.fixed.aid","wlan.fixed.status_code","wlan.fixed.reason_code","wlan.fixed.auth.alg","wlan.fixed.auth_seq","wlan.fixed.category_code","wlan.fixed.action_code","wlan.tag.number","wlan.tag.vendor.oui.type","wlan.country_info.code","wlan.ds.current_channel","wlan.duration","radiotap.datarate","radiotap.dbm_antsignal","radiotap.dbm_antnoise","eap.identity","eap.code","eap.type","eapol.keydes.replay_counter","wlan_rsna_eapol.keydes.nonce","wlan_rsna_eapol.keydes.data","eapol.keydes.key_iv","wlan.mobility_domain.mdid","wlan.ft.subelem.r0kh_id","wlan.ft.subelem.r1kh_id","wlan.rsn.akms.type","wlan.rsn.pcs.type","wlan.fc.retry","wlan.fc.pwrmgt","wlan.fc.moredata","wlan.fc.protected","wlan.fc.order","frame.len","wlan.qbss.cu","wlan.tim.dtim_period","wlan.extcap","wlan.supported_rates","wlan.ext_tag.number","wps.device_name","wps.model_name","wps.manufacturer","wlan.interworking.access_network_type","wlan.fixed.timestamp"]
cmd=["tshark","-r",f,"-T","fields","-E","separator=\x01","-E","occurrence=a","-E","aggregator=|"]
for x in F: cmd+=["-e",x]
cmd+=["-e","frame.number"]
p=subprocess.Popen(cmd,stdout=subprocess.PIPE,text=True,errors="replace")
vals={x:collections.Counter() for x in F}; first={}
for line in p.stdout:
    parts=line.rstrip("\n").split("\x01")
    n=parts[-1]
    for name,v in zip(F,parts):
        if v=="" or name in ("wlan.fixed.timestamp",): continue
        vals[name][v]+=1
        first.setdefault((name,v),n)
res={}
for name,c in vals.items():
    res[name]={"distinct":len(c),"top":c.most_common(25),"rare":[(v,k,first[(name,v)]) for v,k in sorted(c.items(),key=lambda x:x[1]) if k<=2][:40]}
json.dump(res,open(out,"w"))
print("done",f)

import pandas as pd, numpy as np
df=pd.read_pickle('/work/all.pkl')
e=df[df.st.isin([0,1,2,3,10,11,12,13,40,32,44])].copy()
names={0:'AsReq',1:'AsResp',2:'ReReq',3:'ReResp',10:'Disas',11:'Auth',12:'Deauth',13:'Act',40:'QoS',32:'Data',44:'QNull'}
def cli(r):
    for c in ['wlan.ta','wlan.ra']:
        m=r[c]
        if isinstance(m,str) and not m.startswith('00:0b:86') and not m.startswith('33:33') and m!='ff:ff:ff:ff:ff:ff': return m
    return 'BCAST:'+str(r['wlan.ta'])
e['cli']=e.apply(cli,axis=1)
def desc(r):
    s=f"{r.rel:8.3f} s{r.sensor} {names[r.st]}"
    s+= ' AP>' if str(r['wlan.ta']).startswith('00:0b:86') else ' C>'
    s+=str(r['wlan.bssid'])[-8:]
    s+=f" seq{r['wlan.seq']}"
    if r['wlan.fc.retry']=='1' or r['wlan.fc.retry']=='True': s+=' R'
    for k,lab in [('wlan.fixed.reason_code','rc'),('wlan.fixed.status_code','sc'),('wlan.fixed.auth_seq','aseq'),('wlan_rsna_eapol.keydes.msgnr','M'),('eap.code','eapc'),('eap.type','eapt'),('eap.identity','id'),('wlan.fixed.category_code','cat'),('wlan.fixed.action_code','act'),('wlan.fixed.aid','aid'),('wlan.fixed.auth.alg','alg')]:
        v=r[k]
        if isinstance(v,str): s+=f" {lab}={v}"
    s+=f" sig{r['radiotap.dbm_antsignal']}"
    return s
e['d']=e.apply(desc,axis=1)
e=e.sort_values('t')
e.to_pickle('/work/ev2.pkl')
with open('/work/timeline.txt','w') as f:
    for c,g in e.groupby('cli'):
        f.write(f"==== {c} ({len(g)})\n")
        for d in g.d: f.write(d+'\n')

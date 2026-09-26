import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',50); pd.set_option('display.max_colwidth',80)
df=pd.read_pickle('/work/all.pkl')
nb=df[df.st!=8]
macs=pd.concat([nb['wlan.ta'],nb['wlan.ra'],nb['wlan.sa'],nb['wlan.da']]).dropna().unique()
print('non-AP macs:')
cl=[m for m in macs if not m.startswith('00:0b:86')]
rows=[]
for m in sorted(cl):
    s=nb[(nb['wlan.ta']==m)|(nb['wlan.ra']==m)]
    tx=nb[nb['wlan.ta']==m]
    rows.append(dict(mac=m,n=len(s),ntx=len(tx),sensors=','.join(map(str,sorted(s.sensor.unique()))),first=round(s.rel.min(),1),last=round(s.rel.max(),1),types=dict(s.st.value_counts()), bss=','.join(sorted(set(s['wlan.bssid'].dropna())-{'ff:ff:ff:ff:ff:ff'}))[:80]))
r=pd.DataFrame(rows)
print(r.to_string())

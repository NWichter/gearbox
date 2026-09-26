import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60); pd.set_option('display.max_colwidth',60)
df=pd.read_pickle('/work/all.pkl')
for m in ['02:4d:a6:01:33:2d','12:e2:fd:96:45:29']:
    x=df[(df['wlan.sa']==m)|(df['wlan.da']==m)|(df['wlan.bssid']==m)]
    print(m,len(x)); print(x[['sensor','rel','st','wlan.ta','wlan.ra','wlan.sa','wlan.da','wlan.bssid','ssid_txt']].head(5).to_string())
p=df[df.st==4].copy()
p['ssidraw']=p['wlan.ssid']
print(p.groupby(['wlan.ta','ssid_txt'],dropna=False).agg(n=('rel','size'),sens=('sensor',lambda s: ','.join(map(str,sorted(set(s))))),first=('rel','min'),last=('rel','max'),bss=('wlan.bssid',lambda s: ','.join(sorted(set(s)))[:40])).to_string())

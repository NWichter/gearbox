import pandas as pd, numpy as np
pd.set_option('display.width',250); pd.set_option('display.max_rows',500); pd.set_option('display.max_columns',50)
df=pd.read_pickle('/work/all.pkl')
b=df[df.st==8].copy()
b['sig']=b['radiotap.dbm_antsignal'].str.split(',').str[0].astype(float)
b['noise']=b['radiotap.dbm_antnoise'].str.split(',').str[0].astype(float)
b['seq']=b['wlan.seq'].astype(float)
b['md']=b['wlan.tag.number'].str.contains(',54,')
print(b.groupby(['wlan.ssid','md']).size())
print('sig std per bssid', b.groupby('wlan.bssid').sig.agg(['min','max','std']).describe())
print('noise', b.noise.describe())
b=b.sort_values(['sensor','wlan.bssid','t'])
b['dt']=b.groupby(['sensor','wlan.bssid']).t.diff()
b['dseq']=(b.groupby(['sensor','wlan.bssid']).seq.diff())%4096
print(b.dt.describe())
print('dt hist', pd.cut(b.dt,[0,0.09,0.11,0.25,0.5,1,2,5,10,100,2000]).value_counts().sort_index())
print('dseq hist', b.dseq.value_counts().head(10))
# big gaps
gg=b[b.dt>0.5][['sensor','wlan.bssid','rel','dt','dseq']]
print(len(gg)); print(gg.sort_values('rel').to_string())
b.to_pickle('/work/beacons.pkl')

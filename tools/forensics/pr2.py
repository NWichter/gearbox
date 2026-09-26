import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60)
df=pd.read_pickle('/work/all.pkl')
p=df[df.st==5].copy(); p['retry']=p['wlan.fc.retry']=='1'
p['seq']=p['wlan.seq'].astype(int)
print(p.groupby('wlan.ra').retry.mean().describe())
print(p.groupby('wlan.bssid').retry.mean().describe())
# are retries duplicates of a previous frame seq?
p=p.sort_values('t')
x=p[(p.sensor==1)&(p['wlan.ra']=='3c:58:c2:00:00:01')]
print(x[['rel','wlan.bssid','seq','wlan.fc.retry','radiotap.dbm_antsignal']].head(60).to_string())
# time structure of probe responses to one client
x['gap']=x.rel.diff()
print(x.gap.describe()); print(pd.cut(x.gap,[0,0.01,0.1,1,5,10,20,60,300]).value_counts().sort_index())
a=df[df.st==29]
print('ACK RA prefix', a['wlan.ra'].str[:8].value_counts())

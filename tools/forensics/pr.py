import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60)
df=pd.read_pickle('/work/all.pkl')
p=df[df.st==5]
bb=set(zip(df[df.st==8].sensor,df[df.st==8]['wlan.bssid']))
pb=p.groupby(['sensor','wlan.bssid']).size()
print('probe-resp BSSIDs w/o beacons:', [(k,v) for k,v in pb.items() if k not in bb])
print('beacon BSSIDs w/o proberesp:', [k for k in bb if k not in pb.index])
# probe responses per client per bssid - regularity
x=p[p['wlan.ra']=='3c:58:c2:00:00:03']
print(x.groupby(['sensor','wlan.bssid']).size())
x=x.sort_values('rel'); print(x[['sensor','rel','wlan.bssid','wlan.seq','ssid_txt']].head(30).to_string())
# probe req of 3c:03 times
q=df[(df.st==4)&(df['wlan.ta']=='3c:58:c2:00:00:03')].sort_values('rel')
print(q[['sensor','rel','ssid_txt','wlan.seq','radiotap.dbm_antsignal']].head(20).to_string())
# probe responses per 60 s bin per sensor
p2=p.copy(); p2['bin']=(p2.rel//60).astype(int)
print(p2.groupby(['bin','sensor']).size().unstack().to_string())

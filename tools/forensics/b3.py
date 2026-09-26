import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60)
d=pd.concat([pd.read_csv(f'/work/b0{i}.tsv',sep='\t',dtype=str,quoting=3,usecols=['frame.time_epoch','wlan.bssid','wlan.fc.type_subtype','wlan.fixed.timestamp']).assign(sensor=i) for i in range(1,9)])
d['t']=d['frame.time_epoch'].astype(float); d['tsf']=d['wlan.fixed.timestamp'].astype(float)/1e6
d['off']=d.tsf-d.t
d['delay']=d.groupby(['sensor','wlan.bssid']).off.transform('max')-d.off
T0=1789561450.403127
d['trel']=d.tsf-T0
b=d[d['wlan.fc.type_subtype']=='0x0008'].copy()
b['bin']=(b.trel//30).astype(int)
print('beacon delay ms p95 per 30s bin'); print((b.groupby(['bin','sensor']).delay.quantile(0.95)*1000).unstack().round(1).to_string())
print((b.groupby(['bin','sensor']).delay.mean()*1000).unstack().round(2).to_string())
# TBTT: tsf mod 0.1024
b['phase']=(b.tsf % 0.1024)
b=b.sort_values('tsf')
x=b[(b.sensor==1)&(b['wlan.bssid']=='00:0b:86:01:00:00')&(b.trel>230)&(b.trel<260)]
x['dtsf']=x.tsf.diff()
print(x[['trel','tsf','dtsf','phase','delay']].to_string())

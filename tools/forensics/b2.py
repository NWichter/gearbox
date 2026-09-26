import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60); pd.set_option('display.max_colwidth',100)
d=pd.concat([pd.read_csv(f'/work/b0{i}.tsv',sep='\t',dtype=str,quoting=3).assign(sensor=i) for i in range(1,9)])
for c in d.columns:
    if c in ('frame.number','frame.time_epoch','wlan.fixed.timestamp'): continue
    vc=d[c].value_counts(dropna=False)
    print(c, len(vc), dict(vc.head(12)))
d['t']=d['frame.time_epoch'].astype(float); d['tsf']=d['wlan.fixed.timestamp'].astype(float)/1e6
d['off']=d.tsf-d.t
print(d.groupby(['wlan.fc.type_subtype']).off.describe())
b=d[d['wlan.fc.type_subtype']=='0x0008'].sort_values('t')
b['dtsf']=b.groupby(['sensor','wlan.bssid']).tsf.diff()
print(b.dtsf.describe())
print(b[(b.dtsf<0)|(b.dtsf>0.5)].head(30).to_string())
print(b.groupby(['sensor','wlan.bssid']).off.agg(['min','max','mean']).to_string())

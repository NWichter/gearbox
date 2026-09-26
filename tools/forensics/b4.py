import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60)
d=pd.concat([pd.read_csv(f'/work/b0{i}.tsv',sep='\t',dtype=str,quoting=3,usecols=['frame.time_epoch','wlan.bssid','wlan.fc.type_subtype','wlan.fixed.timestamp']).assign(sensor=i) for i in range(1,9)])
d=d[d['wlan.fc.type_subtype']=='0x0008'].copy()
d['t']=d['frame.time_epoch'].astype(float); d['tsf']=d['wlan.fixed.timestamp'].astype(float)/1e6
T0=1789561450.403127; d['trel']=d.tsf-T0
# fit linear clock model per sensor: t = a + b*tsf using lower envelope; approximate by per-sensor linear fit of off vs tsf using 5th percentile per 30s bin
out=[]
for s,g in d.groupby('sensor'):
    g=g.copy(); g['off']=g.t-g.tsf
    g['bin']=(g.trel//30)
    env=g.groupby('bin').agg(x=('trel','median'),y=('off',lambda v: np.percentile(v,1)))
    p=np.polyfit(env.x,env.y,1)
    g['resid']=(g.off-np.polyval(p,g.trel))*1000
    out.append(g); print('sensor',s,'offset s=%.4f drift ppm=%.2f'%(p[1],p[0]*1e6))
g=pd.concat(out)
print(g.resid.describe())
g['sec']=g.trel.round(0)
x=g.groupby('sec').agg(mx=('resid','max'),p90=('resid',lambda v: np.percentile(v,90)),n=('resid','size'))
print(x.sort_values('mx',ascending=False).head(25))
big=g[g.resid>10]
print(big.groupby(['sec','sensor']).size().unstack(fill_value=0).to_string())

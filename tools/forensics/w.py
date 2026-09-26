import pandas as pd
off={1:0.0,2:0.3099,3:-0.7402,4:1.05,5:-1.22,6:0.4799,7:-0.1901,8:0.87}
drift={1:0,2:17.99e-6,3:-25e-6,4:11.98e-6,5:-9.01e-6,6:21.99e-6,7:-14e-6,8:6.99e-6}
e=pd.read_pickle('/work/ev2.pkl')
e['ta']=[r-off[s]-drift[s]*r for r,s in zip(e.rel,e.sensor)]
e=e.sort_values('ta')
e[['ta','sensor','cli','d']].to_pickle('/work/ev_aligned.pkl')
x=e[(e.ta>228)&(e.ta<260)]
for a,c,d in zip(x.ta,x.cli,x.d): print(f"{a:9.3f} {c:20s} {d}")

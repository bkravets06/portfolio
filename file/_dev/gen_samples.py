#!/usr/bin/env python3
"""Generate mesh samples for file/_dev/samples (used by file/_dev/model.html).

Writes a 10 mm cube (8 verts / 12 tris) and a torus R=20 r=6 (2048 verts /
4096 tris) as binary STL, ASCII STL, OBJ, PLY (ascii + binary), AMF, DAE
(Collada), WRL (VRML 2.0), 3MF and ASCII FBX, plus a few deliberately broken
files for error-path tests.  glTF / GLB / USDZ samples come from
gen_samples_three.mjs (Three.js exporters in Node).  python3 stdlib only.
"""
import math, os, random, struct, zipfile

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'samples')
os.makedirs(OUT, exist_ok=True)


def cube(size=10.0):
    h = size / 2
    v = [(-h, -h, -h), (h, -h, -h), (h, h, -h), (-h, h, -h),
         (-h, -h, h), (h, -h, h), (h, h, h), (-h, h, h)]
    f = [(0, 3, 2), (0, 2, 1), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
         (2, 3, 7), (2, 7, 6), (0, 4, 7), (0, 7, 3), (1, 2, 6), (1, 6, 5)]
    return v, f, None


def torus(R=20.0, r=6.0, nu=64, nv=32):
    v, n, f = [], [], []
    for i in range(nu):
        u = 2 * math.pi * i / nu
        for j in range(nv):
            t = 2 * math.pi * j / nv
            v.append(((R + r * math.cos(t)) * math.cos(u),
                      (R + r * math.cos(t)) * math.sin(u), r * math.sin(t)))
            n.append((math.cos(t) * math.cos(u), math.cos(t) * math.sin(u), math.sin(t)))
    for i in range(nu):
        for j in range(nv):
            a = i * nv + j
            b = ((i + 1) % nu) * nv + j
            c = ((i + 1) % nu) * nv + (j + 1) % nv
            d = i * nv + (j + 1) % nv
            f.append((a, b, c))
            f.append((a, c, d))
    return v, f, n


def face_normal(v, tri):
    a, b, c = (v[i] for i in tri)
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    nx, ny, nz = (ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0])
    l = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return nx / l, ny / l, nz / l


def fmt(x):
    s = ('%.6f' % x).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def w(name, data):
    mode = 'wb' if isinstance(data, (bytes, bytearray)) else 'w'
    with open(os.path.join(OUT, name), mode) as fh:
        fh.write(data)
    print('%-28s %9d bytes' % (name, os.path.getsize(os.path.join(OUT, name))))


def stl_binary(v, f):
    out = bytearray(b'gen_samples.py binary STL'.ljust(80, b'\0'))
    out += struct.pack('<I', len(f))
    for tri in f:
        out += struct.pack('<3f', *face_normal(v, tri))
        for i in tri:
            out += struct.pack('<3f', *v[i])
        out += b'\0\0'
    return bytes(out)


def stl_ascii(v, f, name):
    lines = ['solid %s' % name]
    for tri in f:
        lines.append('  facet normal %s %s %s' % tuple(map(fmt, face_normal(v, tri))))
        lines.append('    outer loop')
        for i in tri:
            lines.append('      vertex %s %s %s' % tuple(map(fmt, v[i])))
        lines.append('    endloop')
        lines.append('  endfacet')
    lines.append('endsolid %s' % name)
    return '\n'.join(lines) + '\n'


def obj(v, f, n, name):
    lines = ['# gen_samples.py', 'o %s' % name]
    lines += ['v %s %s %s' % tuple(map(fmt, p)) for p in v]
    if n:
        lines += ['vn %s %s %s' % tuple(map(fmt, p)) for p in n]
        lines += ['f %d//%d %d//%d %d//%d' % (a + 1, a + 1, b + 1, b + 1, c + 1, c + 1) for a, b, c in f]
    else:
        lines += ['f %d %d %d' % (a + 1, b + 1, c + 1) for a, b, c in f]
    return '\n'.join(lines) + '\n'


def ply_ascii(v, f):
    lines = ['ply', 'format ascii 1.0', 'comment gen_samples.py', 'element vertex %d' % len(v),
             'property float x', 'property float y', 'property float z',
             'element face %d' % len(f), 'property list uchar int vertex_indices', 'end_header']
    lines += ['%s %s %s' % tuple(map(fmt, p)) for p in v]
    lines += ['3 %d %d %d' % t for t in f]
    return '\n'.join(lines) + '\n'


def ply_binary(v, f, n):
    hdr = ['ply', 'format binary_little_endian 1.0', 'comment gen_samples.py', 'element vertex %d' % len(v),
           'property float x', 'property float y', 'property float z']
    if n:
        hdr += ['property float nx', 'property float ny', 'property float nz']
    hdr += ['element face %d' % len(f), 'property list uchar int vertex_indices', 'end_header']
    out = bytearray(('\n'.join(hdr) + '\n').encode())
    for i, p in enumerate(v):
        out += struct.pack('<3f', *p)
        if n:
            out += struct.pack('<3f', *n[i])
    for t in f:
        out += struct.pack('<B3i', 3, *t)
    return bytes(out)


def amf(v, f, name):
    x = ['<?xml version="1.0" encoding="UTF-8"?>', '<amf unit="millimeter" version="1.1">',
         ' <object id="1">', '  <metadata type="name">%s</metadata>' % name, '  <mesh>', '   <vertices>']
    x += ['    <vertex><coordinates><x>%s</x><y>%s</y><z>%s</z></coordinates></vertex>' % tuple(map(fmt, p)) for p in v]
    x += ['   </vertices>', '   <volume>']
    x += ['    <triangle><v1>%d</v1><v2>%d</v2><v3>%d</v3></triangle>' % t for t in f]
    x += ['   </volume>', '  </mesh>', ' </object>', '</amf>']
    return '\n'.join(x) + '\n'


def dae(v, f, name):
    pos = ' '.join(fmt(c) for p in v for c in p)
    idx = ' '.join(str(i) for t in f for i in t)
    return '''<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><created>2026-01-01T00:00:00</created><modified>2026-01-01T00:00:00</modified><unit name="millimeter" meter="0.001"/><up_axis>Z_UP</up_axis></asset>
  <library_geometries>
    <geometry id="%(n)s-mesh" name="%(n)s">
      <mesh>
        <source id="%(n)s-pos">
          <float_array id="%(n)s-pos-array" count="%(nc)d">%(pos)s</float_array>
          <technique_common><accessor source="#%(n)s-pos-array" count="%(nv)d" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common>
        </source>
        <vertices id="%(n)s-verts"><input semantic="POSITION" source="#%(n)s-pos"/></vertices>
        <triangles count="%(nf)d"><input semantic="VERTEX" source="#%(n)s-verts" offset="0"/><p>%(idx)s</p></triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="%(n)s" name="%(n)s" type="NODE"><instance_geometry url="#%(n)s-mesh"/></node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>
''' % dict(n=name, nc=len(v) * 3, nv=len(v), nf=len(f), pos=pos, idx=idx)


def wrl(v, f, name):
    pts = ',\n'.join('          %s %s %s' % tuple(map(fmt, p)) for p in v)
    idx = ',\n'.join('          %d, %d, %d, -1' % t for t in f)
    return '''#VRML V2.0 utf8
# gen_samples.py
DEF %s Transform {
  children [
    Shape {
      appearance Appearance { material Material { diffuseColor 0.8 0.8 0.8 } }
      geometry IndexedFaceSet {
        solid TRUE
        coord Coordinate { point [
%s
        ] }
        coordIndex [
%s
        ]
      }
    }
  ]
}
''' % (name, pts, idx)


def threemf(bodies):
    """bodies: list of (name, vertices, faces)."""
    import io
    model = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
             ' <resources>']
    for i, (name, v, f) in enumerate(bodies):
        model += ['  <object id="%d" name="%s" type="model">' % (i + 1, name), '   <mesh>', '    <vertices>']
        model += ['     <vertex x="%s" y="%s" z="%s"/>' % tuple(map(fmt, p)) for p in v]
        model += ['    </vertices>', '    <triangles>']
        model += ['     <triangle v1="%d" v2="%d" v3="%d"/>' % t for t in f]
        model += ['    </triangles>', '   </mesh>', '  </object>']
    model += [' </resources>', ' <build>'] + ['  <item objectid="%d"/>' % (i + 1) for i in range(len(bodies))] + [' </build>', '</model>']
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr('3D/3dmodel.model', '\n'.join(model) + '\n')
    return buf.getvalue()


def obj_multi(bodies):
    lines = ['# gen_samples.py']
    base = 0
    for name, v, f in bodies:
        lines.append('o %s' % name)
        lines += ['v %s %s %s' % tuple(map(fmt, p)) for p in v]
        lines += ['f %d %d %d' % (a + 1 + base, b + 1 + base, c + 1 + base) for a, b, c in f]
        base += len(v)
    return '\n'.join(lines) + '\n'


def usda(v, f, name):
    return """#usda 1.0
(
    defaultPrim = "%(n)s"
    metersPerUnit = 0.001
    upAxis = "Y"
)

def Xform "%(n)s"
{
    def Mesh "%(n)sMesh"
    {
        int[] faceVertexCounts = [%(counts)s]
        int[] faceVertexIndices = [%(idx)s]
        point3f[] points = [%(pts)s]
    }
}
""" % dict(n=name, counts=', '.join('3' for _ in f), idx=', '.join(str(i) for t in f for i in t),
           pts=', '.join('(%s, %s, %s)' % tuple(map(fmt, p)) for p in v))


def fbx_ascii(v, f, name):
    # FBX 7.4 ASCII: polygons end with a bitwise-NOT'ed last index.
    verts = ','.join(fmt(c) for p in v for c in p)
    poly = ','.join('%d,%d,%d' % (a, b, ~c) for a, b, c in f)
    return '''; FBX 7.4.0 project file
; gen_samples.py
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
\tCreator: "gen_samples.py"
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",2
\t\tP: "FrontAxisSign", "int", "Integer", "",1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",1
\t}
}
Definitions:  {
\tVersion: 100
\tCount: 3
\tObjectType: "GlobalSettings" {
\t\tCount: 1
\t}
\tObjectType: "Geometry" {
\t\tCount: 1
\t}
\tObjectType: "Model" {
\t\tCount: 1
\t}
}
Objects:  {
\tGeometry: 1000, "Geometry::%(n)s", "Mesh" {
\t\tVertices: *%(nvc)d {
\t\t\ta: %(verts)s
\t\t}
\t\tPolygonVertexIndex: *%(npi)d {
\t\t\ta: %(poly)s
\t\t}
\t\tGeometryVersion: 124
\t}
\tModel: 2000, "Model::%(n)s", "Mesh" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
\t\t}
\t\tShading: T
\t\tCulling: "CullingOff"
\t}
}
Connections:  {
\tC: "OO",2000,0
\tC: "OO",1000,2000
}
''' % dict(n=name, nvc=len(v) * 3, npi=len(f) * 3, verts=verts, poly=poly)


for name, (v, f, n) in (('cube', cube()), ('torus', torus())):
    w(name + '.stl', stl_binary(v, f))
    w(name + '_ascii.stl', stl_ascii(v, f, name))
    w(name + '.obj', obj(v, f, n, name))
    w(name + '.ply', ply_ascii(v, f) if name == 'cube' else ply_binary(v, f, n))
    w(name + '.amf', amf(v, f, name))
    w(name + '.dae', dae(v, f, name))
    w(name + '.wrl', wrl(v, f, name))
    w(name + '.3mf', threemf([(name, v, f)]))
    w(name + '.fbx', fbx_ascii(v, f, name))
    print('  %s: %d vertices, %d triangles, bbox x[%s,%s] y[%s,%s] z[%s,%s]' % (
        name, len(v), len(f), fmt(min(p[0] for p in v)), fmt(max(p[0] for p in v)),
        fmt(min(p[1] for p in v)), fmt(max(p[1] for p in v)), fmt(min(p[2] for p in v)), fmt(max(p[2] for p in v))))

# Two bodies in one file (cube at the origin, torus shifted +40 in x): merge + naming tests.
cv, cf, _ = cube()
tv, tf, _ = torus()
tv2 = [(x + 40, y, z) for x, y, z in tv]
w('two_bodies.obj', obj_multi([('cube', cv, cf), ('torus', tv2, tf)]))
w('two_bodies.3mf', threemf([('cube', cv, cf), ('torus', tv2, tf)]))
w('cube.usda', usda(cv, cf, 'cube'))

# cube.glb with a KTX2 (KHR_texture_basisu) texture *required*: the loader must
# still read the geometry after the engine drops the texture requirement.
import json
glb_path = os.path.join(OUT, 'cube.glb')
if os.path.exists(glb_path):
    raw = open(glb_path, 'rb').read()
    magic, version, length = struct.unpack('<4sII', raw[:12])
    chunks, off = [], 12
    while off < length:
        clen, ctype = struct.unpack('<II', raw[off:off + 8])
        chunks.append((ctype, raw[off + 8:off + 8 + clen]))
        off += 8 + clen
    doc = json.loads(chunks[0][1].decode())
    doc.setdefault('extensionsUsed', []).append('KHR_texture_basisu')
    doc.setdefault('extensionsRequired', []).append('KHR_texture_basisu')
    doc['images'] = [{'uri': 'missing.ktx2', 'mimeType': 'image/ktx2'}]
    doc['textures'] = [{'extensions': {'KHR_texture_basisu': {'source': 0}}}]
    doc['materials'][0].setdefault('pbrMetallicRoughness', {})['baseColorTexture'] = {'index': 0}
    jb = json.dumps(doc, separators=(',', ':')).encode()
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    body = struct.pack('<II', len(jb), 0x4E4F534A) + jb
    for ctype, data in chunks[1:]:
        data += b'\0' * ((4 - len(data) % 4) % 4)
        body += struct.pack('<II', len(data), ctype) + data
    w('cube_ktx2.glb', struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body)

# Khronos sample-asset Box with KHR_draco_mesh_compression, packed into a single GLB
# (network; skipped silently when offline).
try:
    import urllib.request
    base = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Box/glTF-Draco/'
    doc = json.loads(urllib.request.urlopen(base + 'Box.gltf', timeout=20).read().decode())
    binary = urllib.request.urlopen(base + doc['buffers'][0]['uri'], timeout=20).read()
    del doc['buffers'][0]['uri']
    doc['buffers'][0]['byteLength'] = len(binary)
    jb = json.dumps(doc, separators=(',', ':')).encode(); jb += b' ' * ((4 - len(jb) % 4) % 4)
    bb = binary + b'\0' * ((4 - len(binary) % 4) % 4)
    body = struct.pack('<II', len(jb), 0x4E4F534A) + jb + struct.pack('<II', len(bb), 0x004E4942) + bb
    w('box_draco.glb', struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body)
except Exception as e:  # noqa
    print('box_draco.glb skipped:', e)

# A larger mesh for performance sanity (200k triangles, ~10 MB binary STL).
v, f, n = torus(nu=400, nv=250)
w('torus_200k.stl', stl_binary(v, f))

# Broken / edge-case inputs.
random.seed(1)
w('garbage.bin', bytes(random.getrandbits(8) for _ in range(2048)))
w('garbage.txt', 'this is not a mesh at all\n' * 40)
w('empty.stl', b'')
w('truncated.stl', stl_binary(*cube()[:2])[:120])      # header claims 12 triangles, has ~1
w('pointcloud.ply', 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n')
w('external.gltf', '{"asset":{"version":"2.0"},"buffers":[{"uri":"cube.bin","byteLength":100}],"scene":0,"scenes":[{"nodes":[]}]}')

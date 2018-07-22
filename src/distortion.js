
function normalize(v) {
    const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    v[0] /= l;
    v[1] /= l;
    v[2] /= l;
}

export default function distortion(position, boundingRect, size, curveness, face) {
    const vec = [];
    const fullRadius = size / Math.sqrt(2);
    const radius = fullRadius / curveness;
    for (let i = 0; i < position.length; i += 3) {
        const x = position[i];
        const y = position[i + 1];
        const z = position[i + 2];

        let u = (x - boundingRect.x) / boundingRect.width * 2 - 1;
        let v = (y - boundingRect.y) / boundingRect.height * 2 - 1;

        u *= curveness;
        v *= curveness;

        const r = z + radius;
        const off = radius - fullRadius;
        switch (face) {
            case 'pz':
                vec[0] = u;
                vec[1] = v;
                vec[2] = 1;
                normalize(vec);
                position[i] = vec[0] * r;
                position[i + 1] = vec[1] * r;
                position[i + 2] = -off + vec[2] * r;
                break;
            case 'px':
                vec[0] = 1;
                vec[1] = v;
                vec[2] = -u;
                normalize(vec);
                position[i] = -off + vec[0] * r;
                position[i + 1] = vec[1] * r;
                position[i + 2] = vec[2] * r;
                break;
            case 'nz':
                vec[0] = -u;
                vec[1] = v;
                vec[2] = -1;
                normalize(vec);
                position[i] = vec[0] * r;
                position[i + 1] = vec[1] * r;
                position[i + 2] = off + vec[2] * r;
                break;
            case 'py':
                vec[0] = -u;
                vec[1] = 1;
                vec[2] = v;
                normalize(vec);
                position[i] = vec[0] * r;
                position[i + 1] = -off + vec[1] * r;
                position[i + 2] = vec[2] * r;
                break;
            case 'nx':
                vec[0] = -1;
                vec[1] = -u;
                vec[2] = v;
                normalize(vec);
                position[i] = off + vec[0] * r;
                position[i + 1] = vec[1] * r;
                position[i + 2] = vec[2] * r;
                break;
            case 'ny':
                vec[0] = u;
                vec[1] = -1;
                vec[2] = v;
                normalize(vec);
                position[i] = vec[0] * r;
                position[i + 1] = off + vec[1] * r;
                position[i + 2] = vec[2] * r;
                break;
        }
    }

    return position;
}

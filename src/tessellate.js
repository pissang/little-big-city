import {Vector3} from 'claygl';
export default function tesselate(position, indices, tolerance) {
    const p1 = new Vector3();
    const p2 = new Vector3();
    const p3 = new Vector3();

    const e1 = new Vector3();
    const e2 = new Vector3();
    const e3 = new Vector3();

    const ee = new Vector3();

    const appendPosition = [];
    const appendIndices = [];

    let vtxOff = position.length / 3;

    const vtxMap = {};
    function addPoint(pt, p1, p2, p3, i1, i2, i3) {
        if (pt === p1) { return i1; }
        else if (pt === p2) { return i2; }
        else if (pt === p3) { return i3; }

        const x = Math.round(pt.array[0] * 100);
        const y = Math.round(pt.array[1] * 100);
        const z = Math.round(pt.array[2] * 100);
        const key = x + '-' + y + '-' + z;
        if (vtxMap[key] != null) {
            return vtxMap[key];
        }

        appendPosition.push(pt.array[0]);
        appendPosition.push(pt.array[1]);
        appendPosition.push(pt.array[2]);

        vtxMap[key] = vtxOff;

        return vtxOff++;
    }

    function addIndices(i1, i2, i3) {
        appendIndices.push(i1);
        appendIndices.push(i2);
        appendIndices.push(i3);
    }

    for (let f = 0; f < indices.length;) {
        const i1 = indices[f++];
        const i2 = indices[f++];
        const i3 = indices[f++];

        Vector3.set(p1, position[i1 * 3], position[i1 * 3 + 1], position[i1 * 3 + 2]);
        Vector3.set(p2, position[i2 * 3], position[i2 * 3 + 1], position[i2 * 3 + 2]);
        Vector3.set(p3, position[i3 * 3], position[i3 * 3 + 1], position[i3 * 3 + 2]);

        if (p1.z > 0 && p2.z > 0 && p3.z > 0) {
            Vector3.sub(e1, p1, p2);
            Vector3.sub(e2, p3, p2);
            Vector3.sub(e3, p3, p1);
            // need tesslation
            const l1 = Vector3.len(e1);
            const l2 = Vector3.len(e2);
            const l3 = Vector3.len(e3);

            if (l1 <= tolerance && l2 <= tolerance && l3 <= tolerance) {
                continue;
            }

            Vector3.scale(e1, e1, 1 / l1);
            Vector3.scale(e2, e2, 1 / l2);

            let e1Points = [p2];
            let e2Points = [p2];
            let step = l1 / Math.floor(l1 / tolerance);
            for (let d = step; d < l1; d += step) {
                const pt = Vector3.scaleAndAdd(new Vector3(), p2, e1, d);
                e1Points.push(pt);
            }
            e1Points.push(p1);

            step = l2 / Math.floor(l2 / tolerance);
            for (let d = step; d < l2; d += step) {
                const pt = Vector3.scaleAndAdd(new Vector3(), p2, e2, d);
                e2Points.push(pt);
            }
            e2Points.push(p3);

            const len1 = e1Points.length;
            const len2 = e2Points.length;

            let lastEdgeIndices = [i2];
            for (let i = 1; i < Math.max(len1, len2); i++) {
                const ii = Math.min(len1 - 1, i);
                const ik = Math.min(len2 - 1, i);
                const p11 = e1Points[ii];
                const p12 = e2Points[ik];

                Vector3.sub(ee, p12, p11);
                const lee = Vector3.len(ee);
                Vector3.scale(ee, ee, 1 / lee);

                const edgeIndices = [];
                edgeIndices.push(addPoint(p11, p1, p2, p3, i1, i2, i3));
                let step = lee / Math.floor(lee / tolerance);
                for (let d = step; d < lee; d += step) {
                    const pt = Vector3.scaleAndAdd(new Vector3(), p11, ee, d);
                    edgeIndices.push(addPoint(pt, p1, p2, p3, i1, i2, i3));
                }
                edgeIndices.push(addPoint(p12, p1, p2, p3, i1, i2, i3));

                const lastEdgeMax = lastEdgeIndices.length - 1;
                for (let m = 0; m < edgeIndices.length - 1; m++) {
                    const m2 = m + 1;
                    const n = Math.min(lastEdgeMax, m);
                    const n2 = Math.min(lastEdgeMax, m2);
                    addIndices(edgeIndices[m], lastEdgeIndices[n], edgeIndices[m2]);
                    if (n !== n2) {
                        addIndices(lastEdgeIndices[n], lastEdgeIndices[n2], edgeIndices[m2]);
                    }
                }

                lastEdgeIndices = edgeIndices;
            }
        }
    }

    if (appendPosition.length) {
        const newPosition = new Float32Array(position.length + appendPosition.length);
        const newIndices = new (newPosition.length / 3 > 0xffff ? Uint32Array : Uint16Array)(
            indices.length + appendIndices.length
        );

        newPosition.set(position);
        newPosition.set(appendPosition, position.length);

        newIndices.set(indices);
        newIndices.set(appendIndices, indices.length);

        return {position: newPosition, indices: newIndices};
    }
    return {position, indices};
}